// Servidor MCP: expõe a busca semântica como ferramentas que o Claude Code pode chamar.
//
// A divisão de trabalho:
//   - este servidor RECUPERA os trechos relevantes (Ollama + índice local)
//   - o Claude Code REDIGE a resposta a partir deles
//
// ⚠️ Transporte stdio: a saída padrão (stdout) é o canal do protocolo. Qualquer
// console.log() aqui corromperia as mensagens e derrubaria a conexão.
// Para depurar, use console.error(), que vai para stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { embed } from "./embed.js";
import { buildVaultIndex, isVaultStale } from "./indexer.js";
import { saveNote } from "./notes.js";
import { listVaults, loadChunks, search, type SearchHit } from "./store.js";
import { loadVaultConfig } from "./vaults.js";

const DEFAULT_LIMIT = 5;

/**
 * Garante que o índice reflete o estado atual das notas antes de responder.
 *
 * Sem isto, editar uma nota e perguntar em seguida devolveria o texto antigo — sem
 * erro e sem aviso, que é a pior falha possível numa ferramenta de memória. A
 * verificação é barata (só `stat` nos arquivos) e a reindexação é incremental, então
 * o caso comum — nada mudou — custa milissegundos.
 */
async function refreshIfStale(vault?: string): Promise<void> {
    const config = loadVaultConfig();
    const names = vault === undefined ? Object.keys(config) : [vault];

    for (const name of names) {
        const vaultConfig = config[name];
        if (vaultConfig === undefined) {
            continue;
        }

        try {
            if (!isVaultStale(name, vaultConfig)) {
                continue;
            }
            console.error(`[dev-second-brain] "${name}" mudou — reindexando...`);
            const result = await buildVaultIndex(name, vaultConfig);
            console.error(
                `[dev-second-brain] "${name}" atualizado: ${result.computed} novos, `
                + `${result.reused} reaproveitados (${result.elapsedSeconds.toFixed(1)}s)`,
            );
        } catch (error) {
            // Uma fonte inacessível não pode impedir a busca no que já está indexado.
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`[dev-second-brain] falha ao reindexar "${name}": ${detail}`);
        }
    }
}

const server = new McpServer({
    name: "dev-second-brain",
    version: "0.1.0",
});

server.registerTool(
    "list_vaults",
    {
        title: "Listar vaults",
        description:
            "Lista os vaults (projetos) disponíveis no segundo cérebro do Heitor. "
            + "Use antes de search_notes quando não souber qual vault corresponde ao "
            + "projeto mencionado na pergunta.",
        inputSchema: {},
    },
    () => {
        const vaults = listVaults();
        const text = vaults.length === 0
            ? "Nenhum vault indexado ainda. Rode `npm run ingest` no projeto dev-second-brain."
            : `Vaults disponíveis: ${vaults.join(", ")}`;

        return { content: [{ type: "text", text }] };
    },
);

server.registerTool(
    "search_notes",
    {
        title: "Buscar nas notas",
        description:
            "Busca semântica nas notas pessoais do Heitor — decisões técnicas, contexto de "
            + "projetos e registros de reuniões. Encontra por SIGNIFICADO, não por palavra "
            + "exata, então vale usar a pergunta do usuário como está. "
            + "Use sempre que a pergunta for sobre decisões passadas, o histórico de um "
            + "projeto ou 'o que a gente decidiu sobre X'. "
            + "Cite sempre a nota de origem devolvida em cada resultado. "
            + "IMPORTANTE: a busca SEMPRE devolve os trechos mais próximos, mesmo quando "
            + "nenhum responde à pergunta — a pontuação ordena os resultados entre si e "
            + "não mede relevância absoluta. Leia os trechos e julgue você mesmo se eles "
            + "de fato respondem. Se não responderem, diga que não encontrou registro "
            + "sobre o assunto; nunca construa uma resposta a partir de trechos que só "
            + "compartilham uma palavra com a pergunta.",
        inputSchema: {
            query: z.string().describe("A pergunta ou tema a buscar, em linguagem natural."),
            vault: z.string().optional().describe(
                "Limita a busca a um projeto específico. Omita para buscar em todos os "
                + "vaults — útil em perguntas do tipo 'em quais projetos eu usei X?'.",
            ),
            limit: z.number().int().min(1).max(20).optional().describe(
                `Quantos trechos devolver (padrão ${DEFAULT_LIMIT}).`,
            ),
        },
    },
    async ({ query, vault, limit }) => {
        await refreshIfStale(vault);
        const chunks = loadChunks(vault);

        if (chunks.length === 0) {
            const available = listVaults();
            const text = vault !== undefined && available.length > 0
                ? `O vault "${vault}" não existe. Disponíveis: ${available.join(", ")}.`
                : "Nenhuma nota indexada. Rode `npm run ingest` no projeto dev-second-brain.";
            return { content: [{ type: "text", text }] };
        }

        // A pergunta precisa passar pelo Ollama para virar vetor. Chamado de outra
        // pasta, é comum o serviço estar parado — melhor dizer isso do que estourar.
        let queryEmbedding: number[];
        try {
            queryEmbedding = await embed(query);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: "text",
                    text: "Não consegui gerar o vetor da pergunta — o Ollama parece estar "
                        + `indisponível em localhost:11434 (${detail}). `
                        + "Tente `systemctl start ollama` e repita a busca.",
                }],
                isError: true,
            };
        }

        const hits = search(queryEmbedding, chunks, limit ?? DEFAULT_LIMIT);

        return { content: [{ type: "text", text: formatHits(query, hits) }] };
    },
);

server.registerTool(
    "save_note",
    {
        title: "Registrar nota",
        description:
            "Cria uma nota permanente no segundo cérebro do Heitor, a partir do que foi "
            + "conversado. Use quando ele decidir algo, explicar por que escolheu uma "
            + "abordagem, ou pedir para 'anotar', 'registrar' ou 'guardar' alguma coisa. "
            + "Ofereça registrar quando uma decisão relevante for tomada e ainda não estiver "
            + "anotada. "
            + "Escreva o conteúdo como markdown bem estruturado, em português, com seções "
            + "curtas — e SEMPRE inclua o PORQUÊ da decisão e as alternativas descartadas, "
            + "que é o que o Heitor vai querer lembrar meses depois. Não repita o título no "
            + "corpo: ele já vira o cabeçalho da nota. "
            + "A nota fica buscável imediatamente.",
        inputSchema: {
            vault: z.string().describe(
                "Projeto ao qual a nota pertence. Use list_vaults se não souber o nome.",
            ),
            title: z.string().describe(
                "Título curto e descritivo, ex.: 'Decisão: modelo de embedding'. "
                + "Vira o cabeçalho e o nome do arquivo.",
            ),
            content: z.string().describe(
                "Corpo da nota em markdown, sem repetir o título. Prefira seções como "
                + "'O que ficou decidido', 'Por quê', 'Alternativas consideradas'.",
            ),
        },
    },
    async ({ vault, title, content }) => {
        const config = loadVaultConfig();
        const vaultConfig = config[vault];

        if (vaultConfig === undefined) {
            const available = Object.keys(config).join(", ");
            return {
                content: [{ type: "text", text: `Vault "${vault}" não existe. Disponíveis: ${available}.` }],
                isError: true,
            };
        }

        const result = saveNote(vault, vaultConfig, title, content);

        if ("error" in result) {
            return { content: [{ type: "text", text: result.error }], isError: true };
        }

        // Indexa na hora: a nota precisa estar buscável no segundo seguinte, senão
        // registrar e consultar não formam um ciclo.
        let indexNote = "";
        try {
            const indexed = await buildVaultIndex(vault, vaultConfig);
            indexNote = ` Indexada (${indexed.computed} trechos novos).`;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            indexNote = ` A nota foi salva, mas a indexação falhou (${detail}) — `
                + "rode `npm run ingest` quando o Ollama voltar.";
        }

        return {
            content: [{
                type: "text",
                text: `Nota criada em ${vault}/${result.label}.${indexNote}`,
            }],
        };
    },
);

/** Formata os resultados como texto legível — é isso que entra no contexto do Claude. */
function formatHits(query: string, hits: SearchHit[]): string {
    const topScore = hits[0]?.score ?? 0;

    // Aviso explícito quando nem o melhor resultado é forte. Não é um corte — o
    // conteúdo continua sendo entregue — é um sinal para o julgamento de relevância.
    const warning = topScore < 0.45
        ? "\n⚠ Nenhum trecho teve semelhança alta. É provável que o vault não tenha "
            + "registro sobre isto — confira se os trechos abaixo realmente respondem "
            + "antes de usá-los.\n"
        : "";

    const header = `${hits.length} trechos mais próximos de "${query}"`
        + " (pontuação ordena entre si; não mede relevância absoluta):\n"
        + warning;

    const blocks = hits.map((hit, position) => {
        // O texto guardado começa com a linha "Fonte: <arquivo>", redundante aqui.
        const body = hit.text.split("\n").slice(1).join("\n").trim();
        return `--- [${position + 1}] ${hit.vault}/${hit.source} `
            + `(similaridade ${hit.score.toFixed(3)}) ---\n${body}`;
    });

    return [header, ...blocks].join("\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr é seguro: não interfere no protocolo.
console.error("[dev-second-brain] servidor MCP conectado");
