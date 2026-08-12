// Passos 1 a 4 do pipeline: ler as notas, fatiar, embeddar e salvar o índice.
//
// Módulo chamável, não script — o CLI (ingest.ts) e o servidor MCP usam as mesmas
// funções, para que reindexar automaticamente produza exatamente o mesmo resultado
// que reindexar à mão.

import { readFileSync, statSync } from "node:fs";

import { mapWithConcurrency } from "./concurrency.js";
import { embed, EMBEDDING_MODEL } from "./embed.js";
import { hashText, loadEmbeddingCache, loadIndex, saveIndex, type IndexedChunk } from "./store.js";
import { listVaultFiles, type VaultConfig } from "./vaults.js";

const MIN_CHUNK_LENGTH = 120;

// Teto de tamanho. Duas razões: seções muito longas estouram a janela de contexto do
// modelo (o Ollama responde 500), e um vetor único para 20 páginas vira uma média sem
// foco, que não se parece bem com pergunta nenhuma.
const MAX_CHUNK_LENGTH = 2000;

// Ponto ótimo medido nesta máquina. Ajustável para experimentar: EMBED_CONCURRENCY=8
const CONCURRENCY = Number(process.env["EMBED_CONCURRENCY"] ?? 4);

function chunkByHeading(content: string): string[] {
    const lines = content.split("\n");
    const chunks: string[] = [];
    let current: string[] = [];

    for (const line of lines){
        if (line.startsWith("#") && current.length > 0){
            chunks.push(current.join("\n").trim());
            current = [];
        }
        current.push(line);
    }
    if (current.length > 0){
        chunks.push(current.join("\n").trim());
    }
    return chunks;
}

function mergeSmallChunks(chunks: string[], minLength: number): string[] {
    const merged: string[] = [];

    for (const chunk of chunks){
        const previous = merged[merged.length -1];
        // Funde nos dois sentidos: quando o chunk atual é pequeno, e também
        // quando o anterior é pequeno (caso do título solto no topo do arquivo,
        // que não tem um anterior para se fundir).
        const shouldMerge = previous !== undefined
            && (chunk.length < minLength || previous.length < minLength);

        if (shouldMerge){
            merged[merged.length -1] = `${previous}\n\n${chunk}`;
        } else {
            merged.push(chunk);
        }
    }
    return merged;
}

/**
 * Divide trechos longos demais, preferindo quebrar entre parágrafos. O título da
 * seção é repetido no início de cada pedaço para que nenhum deles perca o contexto
 * de onde veio.
 */
function splitLargeChunks(chunks: string[], maxLength: number): string[] {
    const result: string[] = [];

    for (const chunk of chunks) {
        if (chunk.length <= maxLength) {
            result.push(chunk);
            continue;
        }

        const firstLine = chunk.split("\n")[0] ?? "";
        const heading = firstLine.startsWith("#") ? firstLine : "";
        const paragraphs = chunk.split(/\n\s*\n/);

        let current = "";
        const flush = (): void => {
            const trimmed = current.trim();
            if (trimmed.length > 0) {
                // Do segundo pedaço em diante, recoloca o título como contexto.
                const needsHeading = heading !== "" && result.length > 0 && !trimmed.startsWith(heading);
                result.push(needsHeading ? `${heading}\n\n${trimmed}` : trimmed);
            }
            current = "";
        };

        for (const paragraph of paragraphs) {
            // Parágrafo isolado maior que o teto (tabela longa, bloco de código):
            // não há fronteira natural, corta na marra.
            if (paragraph.length > maxLength) {
                flush();
                for (let start = 0; start < paragraph.length; start += maxLength) {
                    current = paragraph.slice(start, start + maxLength);
                    flush();
                }
                continue;
            }

            if (current.length > 0 && current.length + paragraph.length + 2 > maxLength) {
                flush();
            }
            current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
        }
        flush();
    }

    return result;
}

/** Resumo do estado das fontes, usado para detectar mudanças sem reler os arquivos. */
export type SourceStats = {
    fileCount: number;
    /** Data de modificação mais recente entre todos os arquivos, em milissegundos. */
    maxMtimeMs: number;
};

export function collectSourceStats(files: { path: string }[]): SourceStats {
    let maxMtimeMs = 0;
    for (const file of files) {
        const { mtimeMs } = statSync(file.path);
        if (mtimeMs > maxMtimeMs) {
            maxMtimeMs = mtimeMs;
        }
    }
    return { fileCount: files.length, maxMtimeMs };
}

/**
 * O índice salvo está desatualizado em relação às notas?
 *
 * Compara contagem de arquivos e a data de modificação mais recente. A contagem
 * pega criação e remoção de notas; a data pega edições. Ambas são baratas — são
 * chamadas de `stat`, sem ler conteúdo.
 */
export function isVaultStale(vault: string, config: VaultConfig): boolean {
    const index = loadIndex(vault);
    if (index === null || index.model !== EMBEDDING_MODEL || index.sources === undefined) {
        return true;
    }

    const current = collectSourceStats(listVaultFiles(vault, config));
    return current.fileCount !== index.sources.fileCount
        || current.maxMtimeMs > index.sources.maxMtimeMs;
}

export type IngestResult = {
    vault: string;
    fileCount: number;
    chunkCount: number;
    computed: number;
    reused: number;
    failures: string[];
    elapsedSeconds: number;
};

/** Reconstrói o índice de um vault, reaproveitando os embeddings do que não mudou. */
export async function buildVaultIndex(vault: string, config: VaultConfig): Promise<IngestResult> {
    const startedAt = Date.now();
    const files = listVaultFiles(vault, config);

    // Embeddings já calculados numa execução anterior, indexados pelo hash do texto.
    // Vem vazio se o índice não existe ou se foi gerado por outro modelo.
    const cache = loadEmbeddingCache(vault, EMBEDDING_MODEL);

    // 1) Fatiar tudo primeiro, sem embeddar nada.
    type PendingChunk = { source: string; text: string; hash: string };
    const pending: PendingChunk[] = [];

    for (const file of files) {
        const content = readFileSync(file.path, "utf-8");
        // Ordem importa: juntar os pequenos primeiro, depois dividir os grandes —
        // o inverso faria a fusão desfazer as divisões recém-criadas.
        const rawChunks = chunkByHeading(content);
        const merged = mergeSmallChunks(rawChunks, MIN_CHUNK_LENGTH);
        const chunks = splitLargeChunks(merged, MAX_CHUNK_LENGTH);

        for (const chunk of chunks){
            const text = `Fonte: ${file.label}\n${chunk}`;
            pending.push({ source: file.label, text, hash: hashText(text) });
        }
    }

    // 2) Separar o que já está no cache do que precisa ser calculado.
    const toCompute = pending.filter((chunk) => !cache.has(chunk.hash));

    // 3) Embeddar só os novos, em paralelo. Um trecho que falhe é registrado e
    //    pulado: não faz sentido perder mil chunks bons por causa de um problemático.
    const failures: string[] = [];
    const computedEmbeddings = await mapWithConcurrency(
        toCompute,
        CONCURRENCY,
        async (chunk) => {
            try {
                return await embed(chunk.text);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                failures.push(`${chunk.source} (${chunk.text.length} chars): ${detail}`);
                return null;
            }
        },
    );
    toCompute.forEach((chunk, position) => {
        const embedding = computedEmbeddings[position];
        if (embedding !== null && embedding !== undefined) {
            cache.set(chunk.hash, embedding);
        }
    });

    // 4) Montar o índice na ordem original, agora que todo vetor está disponível.
    const chunks: IndexedChunk[] = [];
    for (const chunk of pending) {
        const embedding = cache.get(chunk.hash);
        if (embedding !== undefined) {
            chunks.push({ vault, source: chunk.source, text: chunk.text, hash: chunk.hash, embedding });
        }
    }

    saveIndex(vault, chunks, EMBEDDING_MODEL, collectSourceStats(files));

    return {
        vault,
        fileCount: files.length,
        chunkCount: chunks.length,
        computed: toCompute.length - failures.length,
        reused: pending.length - toCompute.length,
        failures,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
    };
}
