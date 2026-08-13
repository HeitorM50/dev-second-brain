// Servidor MCP: expõe a busca semântica como ferramentas que o Claude Code pode chamar.
//
// A divisão de trabalho:
//   - este servidor RECUPERA os trechos relevantes (Ollama + índice local)
//   - o Claude Code REDIGE a resposta a partir deles
//
// ⚠️ Transporte stdio: a saída padrão (stdout) é o canal do protocolo. Qualquer
// console.log() aqui corromperia as mensagens e derrubaria a conexão.
// Para depurar, use console.error(), que vai para stderr.

import { existsSync, mkdirSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { embed } from "./embed.js";
import { buildVaultIndex, isVaultStale } from "./indexer.js";
import { isSuperseded } from "./frontmatter.js";
import { saveNote } from "./notes.js";
import { getSearchable, hybridSearch, listVaults, type SearchHit } from "./store.js";
import {
    listVaultFiles,
    loadVaultConfig,
    privateNotesDir,
    saveVaultConfig,
    type VaultConfig,
} from "./vaults.js";

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
            since: z.string().optional().describe(
                "Data mínima da nota, no formato AAAA-MM-DD. Use quando a pergunta "
                + "delimitar tempo — 'o que decidimos em julho?' vira since=2026-07-01 "
                + "e until=2026-07-31. A busca semântica NÃO entende datas sozinha; "
                + "sem este filtro, perguntas sobre período não funcionam.",
            ),
            until: z.string().optional().describe("Data máxima da nota, AAAA-MM-DD."),
        },
    },
    async ({ query, vault, limit, since, until }) => {
        await refreshIfStale(vault);
        const searchable = getSearchable(vault);
        const chunks = searchable.chunks;

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

        const hits = hybridSearch(
            query, queryEmbedding, searchable, limit ?? DEFAULT_LIMIT, { since, until },
        );

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

// Acima deste número de arquivos, a primeira indexação passa de alguns minutos e
// travaria a chamada da ferramenta. Nesse caso o vault é registrado e a indexação
// fica por conta do `npm run ingest`.
const INSTANT_INDEX_FILE_LIMIT = 30;

server.registerTool(
    "add_vault",
    {
        title: "Registrar projeto no segundo cérebro",
        description:
            "Cadastra um projeto como vault, para que suas notas e documentação virem "
            + "memória consultável. Use quando o Heitor pedir para 'adicionar este projeto', "
            + "'registrar no segundo cérebro' ou equivalente — inclusive estando dentro de "
            + "outro projeto. "
            + "Passe em `sources` os caminhos ABSOLUTOS das pastas com documentação: "
            + "prefira a pasta específica de documentação (ex.: <projeto>/docs) em vez da "
            + "raiz do repositório, para não indexar README de dependência e arquivos "
            + "gerados. Uma pasta de anotações privadas é criada automaticamente e será o "
            + "destino de save_note — a documentação do projeto nunca é escrita.",
        inputSchema: {
            name: z.string().describe(
                "Nome curto do vault, em minúsculas, sem espaço. É como o projeto será "
                + "chamado nas buscas. Ex.: 'crianex'.",
            ),
            sources: z.array(z.string()).min(1).describe(
                "Caminhos absolutos das pastas com documentação a indexar.",
            ),
            exclude: z.array(z.string()).optional().describe(
                "Trechos de caminho a ignorar, ex.: ['CHANGELOG', 'api-reference'].",
            ),
        },
    },
    async ({ name, sources, exclude }) => {
        const config = loadVaultConfig();

        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
            return {
                content: [{ type: "text", text: `Nome inválido: "${name}". Use minúsculas, números e hífens.` }],
                isError: true,
            };
        }
        if (config[name] !== undefined) {
            return {
                content: [{ type: "text", text: `O vault "${name}" já existe. Edite vaults.json para alterá-lo.` }],
                isError: true,
            };
        }

        const missing = sources.filter((source) => !existsSync(source));
        if (missing.length > 0) {
            return {
                content: [{ type: "text", text: `Pasta(s) não encontrada(s): ${missing.join(", ")}` }],
                isError: true,
            };
        }

        // Pasta pessoal do vault: é para lá que save_note escreve, nunca para a
        // documentação do projeto — que pode estar num repositório de trabalho.
        // Gravada no config como caminho relativo, para o repositório continuar
        // funcionando se for movido de lugar.
        const notesDir = privateNotesDir(name);
        const notesDirRelative = `notes/${name}`;
        mkdirSync(notesDir, { recursive: true });

        const vaultConfig: VaultConfig = {
            sources: [...sources, notesDirRelative],
            ...(exclude !== undefined ? { exclude } : {}),
            writeTo: notesDirRelative,
        };

        config[name] = vaultConfig;
        saveVaultConfig(config);

        const files = listVaultFiles(name, vaultConfig);
        const lines = [
            `Vault "${name}" registrado com ${files.length} arquivos .md.`,
            `Anotações privadas em: ${notesDir}`,
        ];

        if (files.length <= INSTANT_INDEX_FILE_LIMIT) {
            try {
                const result = await buildVaultIndex(name, vaultConfig);
                lines.push(
                    `Indexado: ${result.chunkCount} trechos em ${result.elapsedSeconds.toFixed(1)}s. `
                    + "Já pode fazer perguntas sobre este projeto.",
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                lines.push(`A indexação falhou (${detail}). Rode \`npm run ingest\` no dev-second-brain.`);
            }
        } else {
            lines.push(
                `São muitos arquivos para indexar agora (limite: ${INSTANT_INDEX_FILE_LIMIT}). `
                + "Rode `npm run ingest` no diretório do dev-second-brain — pode levar alguns "
                + "minutos na primeira vez. Depois disso, atualizações são automáticas.",
            );
        }

        lines.push(
            "",
            "Sugira ao Heitor acrescentar este bloco ao CLAUDE.md do projeto, para que as "
            + "decisões passem a ser registradas sem ele precisar pedir toda vez:",
            "",
            "```markdown",
            "## Registro de decisões no segundo cérebro",
            "",
            `Este projeto usa o dev-second-brain (MCP). Vault: **${name}**.`,
            "",
            "- Ao tomar uma decisão técnica (escolha de biblioteca, mudança de abordagem,",
            `  alternativa descartada), registre com \`save_note\` no vault \`${name}\`,`,
            "  incluindo sempre o **porquê** e as alternativas consideradas.",
            `- Antes de propor mudança estrutural, consulte \`search_notes\` no vault \`${name}\``,
            "  para não contrariar algo já decidido.",
            "- NÃO registre mudanças triviais (renomear variável, typo, formatação):",
            "  nota é para decisão, não para diff.",
            "```",
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
    },
);

/** Formata os resultados como texto legível — é isso que entra no contexto do Claude. */
// Medido em `npm run eval`: o pior acerto legítimo fica em 0,377 e o melhor falso
// positivo em 0,353 — margem estreitíssima. Por isso este número não CORTA nada,
// apenas sinaliza; quem decide relevância é a leitura do conteúdo.
const WEAK_SIMILARITY = 0.40;

function formatHits(query: string, hits: SearchHit[]): string {
    const topCosine = hits[0]?.cosine ?? 0;

    const warning = topCosine < WEAK_SIMILARITY
        ? "\n⚠ Nenhum trecho teve semelhança alta. É provável que não exista registro "
            + "sobre isto — confira se os trechos abaixo realmente respondem antes de "
            + "usá-los, e prefira dizer que não encontrou a inventar uma resposta.\n"
        : "";

    const header = `${hits.length} trechos mais próximos de "${query}"`
        + " (busca híbrida: semântica + palavra-chave):\n"
        + warning;

    const blocks = hits.map((hit, position) => {
        // O texto guardado começa com a linha "Fonte: <arquivo>", redundante aqui.
        const body = hit.text.split("\n").slice(1).join("\n").trim();

        const date = hit.meta.date !== undefined ? `, ${hit.meta.date}` : "";

        // O aviso mais importante da saída: a nota existe, mas foi revista. Sem isto,
        // uma decisão revogada seria apresentada como se ainda valesse.
        const superseded = isSuperseded(hit.meta)
            ? `\n⚠️ DECISÃO REVISTA — esta nota foi substituída`
                + `${hit.meta.supersededBy !== undefined ? ` por "${hit.meta.supersededBy}"` : ""}. `
                + "Não a apresente como decisão vigente; diga que foi superada e, se útil, "
                + "busque a nota que a substitui."
            : "";

        return `--- [${position + 1}] ${hit.vault}/${hit.source}${date} `
            + `(semelhança ${hit.cosine.toFixed(3)}, `
            + `termos em comum ${(hit.coverage * 100).toFixed(0)}%) ---${superseded}\n${body}`;
    });

    return [header, ...blocks].join("\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr é seguro: não interfere no protocolo.
console.error("[dev-second-brain] servidor MCP conectado");
