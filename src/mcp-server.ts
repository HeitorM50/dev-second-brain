// Servidor MCP: expõe a busca semântica como ferramentas que o Claude Code pode chamar.
//
// A divisão de trabalho:
//   - este servidor RECUPERA os trechos relevantes (Ollama + índice local)
//   - o Claude Code REDIGE a resposta a partir deles
//
// ⚠️ Transporte stdio: a saída padrão (stdout) é o canal do protocolo. Qualquer
// console.log() aqui corromperia as mensagens e derrubaria a conexão.
// Para depurar, use console.error(), que vai para stderr.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { mapWithConcurrency } from "./concurrency.js";
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

// Medido em `npm run eval`: o pior acerto legítimo fica em 0,377 e o melhor falso
// positivo em 0,353 — margem estreitíssima. Por isso este número não CORTA nada,
// apenas sinaliza; quem decide relevância é a leitura do conteúdo.
const WEAK_SIMILARITY = 0.40;

// Acima disso a revisão vira despejo: muitas linhas para o Claude comparar de uma vez,
// e ~1s de embedding por decisão a mais de espera.
const MAX_DECISIONS = 10;

// Duas notas por decisão bastam para julgar "isso já está registrado?". Mais que isso
// enche o contexto sem acrescentar informação — a terceira já costuma ser ruído.
const REVIEW_NEIGHBORS = 2;

// Ponto ótimo medido no indexador; mesma razão vale aqui (embeddar é limitado por CPU).
const CONCURRENCY = Number(process.env["EMBED_CONCURRENCY"] ?? 4);

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

/** Título do bloco. Serve também de marcador para não instalá-lo duas vezes. */
const CAPTURE_RULE_HEADING = "## Registro de decisões no segundo cérebro";

/**
 * O ritual de captura, em forma de instrução para o CLAUDE.md do projeto.
 *
 * Uma função só porque este texto tem dois destinos — ser gravado no arquivo e ser
 * impresso como sugestão. Duplicá-lo garantiria que um dia os dois divergissem.
 */
function captureRuleBlock(vault: string): string {
    return [
        CAPTURE_RULE_HEADING,
        "",
        `Este projeto usa o dev-second-brain (MCP). Vault: **${vault}**.`,
        "",
        "**Durante o trabalho**",
        "- Ao tomar uma decisão técnica (escolha de biblioteca, mudança de abordagem,",
        `  alternativa descartada), ofereça registrar com \`save_note\` no vault \`${vault}\` —`,
        "  sempre com o **porquê** e as alternativas consideradas.",
        `- Antes de propor mudança estrutural, consulte \`search_notes\` no vault \`${vault}\``,
        "  para não contrariar algo já decidido.",
        "",
        "**Revisão de captura** — execute quando o Heitor sinalizar que está encerrando",
        "(\"é isso por hoje\", \"pode parar\", \"vamos commitar\") **e** sempre antes de um commit:",
        "",
        "1. Releia a conversa e liste as decisões tomadas — uma frase curta e autocontida",
        "   cada. Se não houve decisão nenhuma, diga isso em uma linha e siga adiante;",
        "   nunca invente conteúdo para ter o que registrar.",
        `2. Chame \`review_decisions\` com essa lista, vault \`${vault}\`.`,
        "3. LEIA os trechos devolvidos. Semelhança alta NÃO prova que a decisão já está",
        "   registrada — só considere coberta aquela cujo trecho de fato diz a mesma coisa.",
        "4. Mostre ao Heitor as que sobraram e pergunte quais registrar.",
        "5. Grave **uma nota por decisão** com `save_note` — nunca uma nota-diário juntando",
        "   várias. Cada nota responde: o que ficou decidido · por quê · o que foi descartado.",
        "",
        "**Não registre** mudança trivial (renomear variável, typo, formatação), nem o que já",
        "está em nota, nem \"o que foi feito\" — nota é para decisão, não para diff nem changelog.",
    ].join("\n");
}

/**
 * Grava o bloco no CLAUDE.md do projeto.
 *
 * Só é chamada quando o Heitor autoriza explicitamente (ver `projectRoot` na descrição
 * da ferramenta): isto escreve DENTRO do repositório de outro projeto, que pode ser de
 * trabalho ou de um grupo. Por isso nunca sobrescreve — só acrescenta ao fim — e
 * reconhece o próprio bloco pelo título para não empilhar cópias a cada chamada.
 */
function installCaptureRule(projectRoot: string, vault: string): string {
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
        return `⚠ Não instalei a regra: "${projectRoot}" não é uma pasta existente.`;
    }

    const target = join(projectRoot, "CLAUDE.md");
    const block = captureRuleBlock(vault);

    if (!existsSync(target)) {
        writeFileSync(target, `${block}\n`, "utf-8");
        return `Regra de captura instalada em ${target} (arquivo criado).`;
    }

    const current = readFileSync(target, "utf-8");
    if (current.includes(CAPTURE_RULE_HEADING)) {
        return `A regra de captura já estava em ${target} — não duplicada.`;
    }

    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(target, `${current}${separator}${block}\n`, "utf-8");
    return `Regra de captura acrescentada ao fim de ${target} (conteúdo anterior preservado).`;
}

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
        // Sem `projectRoot` o comportamento é o de sempre: nada é escrito fora daqui.
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
            projectRoot: z.string().optional().describe(
                "Caminho absoluto da RAIZ do projeto. Se informado, a regra de registro de "
                + "decisões é gravada no CLAUDE.md de lá, e o projeto passa a capturar "
                + "decisões sozinho. Isto ESCREVE dentro do repositório do outro projeto: "
                + "PERGUNTE ao Heitor e só preencha depois que ele autorizar. Omitido, a "
                + "regra é apenas sugerida como texto, sem tocar em nenhum arquivo. "
                + "Se o vault JÁ existir, a chamada não o altera e serve só para instalar a "
                + "regra — nesse caso `sources` é ignorado, pode repetir o projectRoot nele.",
            ),
        },
    },
    async ({ name, sources, exclude, projectRoot }) => {
        const config = loadVaultConfig();

        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
            return {
                content: [{ type: "text", text: `Nome inválido: "${name}". Use minúsculas, números e hífens.` }],
                isError: true,
            };
        }
        // Vault já registrado não se registra de novo — mas instalar a regra de captura
        // num projeto que já é vault é caso legítimo e comum: é exatamente o que acontece
        // com todo projeto adicionado antes de esta regra existir.
        if (config[name] !== undefined) {
            if (projectRoot !== undefined) {
                return {
                    content: [{
                        type: "text",
                        text: `O vault "${name}" já existe — mantido como está.\n`
                            + installCaptureRule(projectRoot, name),
                    }],
                };
            }
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

        // Registrar o vault resolve metade do problema: dá para CONSULTAR o projeto. A
        // outra metade — as decisões novas virarem nota — depende de o projeto carregar
        // a instrução. Enquanto isso dependia de copiar e colar à mão, não acontecia.
        if (projectRoot !== undefined) {
            lines.push("", installCaptureRule(projectRoot, name));
        } else {
            lines.push(
                "",
                "O projeto ainda NÃO captura decisões sozinho. Pergunte ao Heitor se pode "
                + "instalar a regra abaixo no CLAUDE.md dele — se ele autorizar, chame esta "
                + "ferramenta de novo passando `projectRoot`. Caso prefira colar à mão:",
                "",
                "```markdown",
                captureRuleBlock(name),
                "```",
            );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    },
);

/**
 * As notas distintas mais próximas de um texto.
 *
 * A busca devolve TRECHOS, e uma nota longa costuma ocupar várias das primeiras
 * posições — o que responderia "as duas mais parecidas" com o mesmo arquivo duas vezes.
 * Para revisar duplicata o que importa é quais NOTAS já falam do assunto, então aqui
 * pedimos com folga e ficamos só com o melhor trecho de cada arquivo.
 */
function nearestNotes(
    searchable: ReturnType<typeof getSearchable>,
    text: string,
    embedding: number[],
): SearchHit[] {
    const hits = hybridSearch(text, embedding, searchable, REVIEW_NEIGHBORS * 4);

    const bestPerSource: SearchHit[] = [];
    const seen = new Set<string>();

    for (const hit of hits) {
        const key = `${hit.vault}/${hit.source}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        bestPerSource.push(hit);
        if (bestPerSource.length === REVIEW_NEIGHBORS) {
            break;
        }
    }

    return bestPerSource;
}

/** Primeiras palavras do trecho, em uma linha só, para dar contexto sem inchar a saída. */
function excerpt(hit: SearchHit, maxChars = 150): string {
    // A primeira linha do texto guardado é "Fonte: <arquivo>", já mostrada no cabeçalho.
    const body = hit.text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
    return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

server.registerTool(
    "review_decisions",
    {
        title: "Revisar decisões antes de registrar",
        description:
            "Verifica, de uma vez só, quais decisões de uma conversa JÁ estão registradas "
            + "no segundo cérebro do Heitor. Use ao fechar uma sessão de trabalho — quando "
            + "ele sinalizar que está encerrando ou antes de um commit — passando em "
            + "`decisions` uma frase curta e autocontida por decisão tomada na conversa "
            + "(ex.: 'usar Redis para cache de sessão'), e NÃO um resumo do dia inteiro. "
            + "Para cada uma, devolve as notas existentes mais parecidas. "
            + "IMPORTANTE: a semelhança ordena os resultados entre si e não mede relevância "
            + "absoluta — LEIA os trechos e julgue você mesmo se a decisão já está coberta. "
            + "Depois, ofereça ao Heitor registrar apenas as que sobraram, uma chamada de "
            + "save_note por decisão — nunca uma nota só juntando várias.",
        inputSchema: {
            vault: z.string().describe(
                "Projeto ao qual as decisões pertencem. Use list_vaults se não souber o nome.",
            ),
            decisions: z.array(z.string()).min(1).max(MAX_DECISIONS).describe(
                "Uma frase curta por decisão candidata, autocontida o bastante para ser "
                + `buscada sozinha. Máximo ${MAX_DECISIONS}.`,
            ),
        },
    },
    async ({ vault, decisions }) => {
        const config = loadVaultConfig();
        if (config[vault] === undefined) {
            const available = Object.keys(config).join(", ");
            return {
                content: [{ type: "text", text: `Vault "${vault}" não existe. Disponíveis: ${available}.` }],
                isError: true,
            };
        }

        // Sem isto, uma nota salva minutos atrás ainda não estaria no índice e a decisão
        // apareceria como "nova" — justamente a duplicata que a ferramenta existe para evitar.
        await refreshIfStale(vault);
        const searchable = getSearchable(vault);

        if (searchable.chunks.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: `O vault "${vault}" ainda não tem nada indexado — todas as decisões `
                        + "são novas. Ofereça registrar cada uma com save_note.",
                }],
            };
        }

        let embeddings: number[][];
        try {
            embeddings = await mapWithConcurrency(decisions, CONCURRENCY, (text) => embed(text));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: "text",
                    text: "Não consegui gerar os vetores das decisões — o Ollama parece estar "
                        + `indisponível em localhost:11434 (${detail}). `
                        + "Tente `systemctl start ollama` e repita a revisão.",
                }],
                isError: true,
            };
        }

        const blocks = decisions.map((decision, index) => {
            const embedding = embeddings[index] ?? [];
            const neighbours = nearestNotes(searchable, decision, embedding);
            const best = neighbours[0]?.cosine ?? 0;

            const lines = neighbours.map(
                (hit) => `    ${hit.source} (${hit.cosine.toFixed(3)}) — "${excerpt(hit)}"`,
            );

            // Mesmo critério do formatHits: sinaliza, nunca corta — e ACRESCENTA à lista
            // em vez de substituí-la. Medido: uma decisão comprovadamente ausente do
            // acervo ainda pontua ~0,52, acima do limiar. Ou seja, o aviso silenciado
            // não significa "está registrada"; só a leitura dos trechos decide isso.
            if (best < WEAK_SIMILARITY) {
                lines.push(
                    `    ⚠ semelhança fraca (melhor ${best.toFixed(3)}) — indício forte de `
                    + "que o assunto não existe no acervo",
                );
            }

            return [`[${index + 1}] ${decision}`, ...lines].join("\n");
        });

        const header = `Revisão de ${decisions.length} decisão(ões) no vault "${vault}" — `
            + "notas existentes mais próximas de cada uma.\n"
            + "⚠ A semelhança ORDENA, não julga. Um valor alto NÃO prova que a decisão já "
            + "está registrada: a busca sempre devolve o que tem de mais próximo, mesmo "
            + "quando nada trata do assunto. LEIA cada trecho e decida você. Só considere "
            + "coberta a decisão cujo trecho realmente diz a mesma coisa.\n";

        return { content: [{ type: "text", text: [header, ...blocks].join("\n\n") }] };
    },
);

/** Formata os resultados como texto legível — é isso que entra no contexto do Claude. */
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
