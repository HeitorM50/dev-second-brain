// Fronteira de armazenamento e busca.
//
// O resto do sistema só conhece as funções exportadas daqui — ninguém mais sabe
// que por baixo existem arquivos JSON. Trocar por SQLite ou Postgres um dia
// significa reescrever só este arquivo.
//
// Cada vault (= um projeto) tem seu próprio arquivo de índice, para que uma
// pergunta sobre um projeto não traga trechos de outro.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type IndexedChunk = {
    vault: string;
    source: string;
    text: string;
    /** Impressão digital do texto — identifica um chunk inalterado entre execuções. */
    hash: string;
    embedding: number[];
};

/**
 * O arquivo salvo em disco, um por vault. Guarda o modelo junto dos chunks porque
 * vetores de modelos diferentes não são comparáveis: se o modelo mudar, o cache
 * inteiro precisa ser descartado.
 */
type IndexFile = {
    model: string;
    chunks: IndexedChunk[];
};

// Um resultado de busca é um chunk + o quanto ele combina com a pergunta.
export type SearchHit = IndexedChunk & { score: number };

const VAULTS_DIR = join("data", "vaults");

function indexPath(vault: string): string {
    return join(VAULTS_DIR, `${vault}.json`);
}

/** SHA-256 em hexadecimal. Mesmo texto → mesmo hash; uma letra diferente → hash totalmente diferente. */
export function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Nomes dos vaults que já possuem índice construído. */
export function listVaults(): string[] {
    if (!existsSync(VAULTS_DIR)) {
        return [];
    }
    return readdirSync(VAULTS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.replace(/\.json$/, ""))
        .sort();
}

export function saveIndex(vault: string, chunks: IndexedChunk[], model: string): void {
    mkdirSync(VAULTS_DIR, { recursive: true });
    const file: IndexFile = { model, chunks };
    writeFileSync(indexPath(vault), JSON.stringify(file), "utf-8");
}

/** Devolve null se o vault não tem índice ou se o arquivo está ilegível. */
export function loadIndex(vault: string): IndexFile | null {
    const path = indexPath(vault);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (
            typeof parsed !== "object" || parsed === null
            || !("model" in parsed) || !("chunks" in parsed)
        ) {
            return null;
        }
        return parsed as IndexFile;
    } catch {
        return null;
    }
}

/**
 * Carrega os chunks de um vault específico, ou de todos quando `vault` é undefined.
 * A busca cruzada serve para perguntas do tipo "em quais projetos usei Postgres?".
 */
export function loadChunks(vault?: string): IndexedChunk[] {
    const vaults = vault === undefined ? listVaults() : [vault];
    const chunks: IndexedChunk[] = [];

    for (const name of vaults) {
        const index = loadIndex(name);
        if (index !== null) {
            chunks.push(...index.chunks);
        }
    }
    return chunks;
}

/**
 * Mapa `hash → embedding` dos chunks já calculados naquele vault, para reaproveitar
 * o que não mudou. Devolve vazio se o índice não existe ou foi gerado por OUTRO
 * modelo — nesse caso os vetores antigos são incompatíveis e tudo é recalculado.
 */
export function loadEmbeddingCache(vault: string, model: string): Map<string, number[]> {
    const cache = new Map<string, number[]>();
    const previous = loadIndex(vault);

    if (previous === null || previous.model !== model) {
        return cache;
    }

    for (const chunk of previous.chunks) {
        cache.set(chunk.hash, chunk.embedding);
    }
    return cache;
}

/**
 * Cosseno do ângulo entre dois vetores: 1 = mesma direção, 0 = sem relação.
 *
 * Fórmula:  (a · b) / (|a| × |b|)
 *   a · b  = produto escalar — soma dos produtos posição a posição
 *   |a|    = comprimento do vetor — raiz da soma dos quadrados
 *
 * Dividir pelos comprimentos é o que remove o tamanho da conta e deixa
 * só a direção. Sem isso, textos longos pareceriam sempre mais relevantes.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
        // ?? 0 porque noUncheckedIndexedAccess trata todo acesso por índice
        // como possivelmente indefinido.
        const valueA = a[i] ?? 0;
        const valueB = b[i] ?? 0;

        dotProduct += valueA * valueB;
        magnitudeA += valueA * valueA;
        magnitudeB += valueB * valueB;
    }

    return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

/**
 * Varredura linear: compara a pergunta com TODOS os chunks, ordena pela
 * pontuação e devolve os k melhores. Simples de propósito — com alguns
 * milhares de chunks isso custa milissegundos.
 */
export function search(queryEmbedding: number[], chunks: IndexedChunk[], k: number): SearchHit[] {
    const scored: SearchHit[] = chunks.map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((first, second) => second.score - first.score);

    return scored.slice(0, k);
}
