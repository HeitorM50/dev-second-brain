// Fronteira de armazenamento e busca.
//
// O resto do sistema só conhece as funções exportadas daqui — ninguém mais sabe
// que por baixo existem arquivos JSON. Trocar por SQLite ou Postgres um dia
// significa reescrever só este arquivo.
//
// Cada vault (= um projeto) tem seu próprio arquivo de índice, para que uma
// pergunta sobre um projeto não traga trechos de outro.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isSuperseded, withinDateRange, type NoteMeta } from "./frontmatter.js";
import { buildNoteIndex, extractLinks } from "./links.js";
import {
    buildLexicalIndex,
    lexicalCoverage,
    reciprocalRankFusion,
    scoreBM25,
    tokenize,
    type LexicalIndex,
} from "./lexical.js";

export type IndexedChunk = {
    vault: string;
    source: string;
    /** Metadados do front-matter da nota de origem. Vazio quando ela não declara. */
    meta: NoteMeta;
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
    /** Estado das notas quando o índice foi gerado, para detectar edições depois. */
    sources?: { fileCount: number; maxMtimeMs: number } | undefined;
    chunks: IndexedChunk[];
};

// Um resultado de busca é um chunk mais os sinais que o colocaram ali.
export type SearchHit = IndexedChunk & {
    /** Pontuação de ordenação. Fusão RRF na busca híbrida; cosseno puro em `search`. */
    score: number;
    /** Similaridade de cosseno, de −1 a 1. Ordinal: compara resultados entre si. */
    cosine: number;
    /** BM25: quanto os termos da pergunta pesam neste trecho. Sem teto fixo. */
    bm25: number;
    /** Fração dos termos da pergunta presentes no trecho, de 0 a 1. Absoluta. */
    coverage: number;
};

// Ancorado na localização deste arquivo (src/), não no diretório de trabalho.
// Sem isso, o servidor MCP iniciado de outra pasta procuraria o índice no lugar errado.
const PROJECT_ROOT = join(import.meta.dirname, "..");
const VAULTS_DIR = join(PROJECT_ROOT, "data", "vaults");

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

export function saveIndex(
    vault: string,
    chunks: IndexedChunk[],
    model: string,
    sources?: { fileCount: number; maxMtimeMs: number },
): void {
    mkdirSync(VAULTS_DIR, { recursive: true });
    const file: IndexFile = { model, sources, chunks };
    writeFileSync(indexPath(vault), JSON.stringify(file), "utf-8");
    // O arquivo mudou: o que estiver em memória virou lixo.
    memoryCache.delete(vault);
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
 * Índices já carregados, guardados entre chamadas.
 *
 * Faz diferença no servidor MCP, que é um processo de longa duração: sem isto, cada
 * pergunta releria e reinterpretaria dezenas de megabytes de JSON. A entrada é
 * invalidada pela data de modificação do arquivo, então uma reindexação externa
 * (`npm run ingest` noutro terminal) é percebida na busca seguinte.
 */
const memoryCache = new Map<string, { mtimeMs: number; chunks: IndexedChunk[] }>();

function chunksOfVault(vault: string): IndexedChunk[] {
    const path = indexPath(vault);
    if (!existsSync(path)) {
        return [];
    }

    const { mtimeMs } = statSync(path);
    const cached = memoryCache.get(vault);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
        return cached.chunks;
    }

    const index = loadIndex(vault);
    const chunks = index?.chunks ?? [];
    memoryCache.set(vault, { mtimeMs, chunks });
    return chunks;
}

/**
 * Carrega os chunks de um vault específico, ou de todos quando `vault` é undefined.
 * A busca cruzada serve para perguntas do tipo "em quais projetos usei Postgres?".
 */
export function loadChunks(vault?: string): IndexedChunk[] {
    const vaults = vault === undefined ? listVaults() : [vault];
    const chunks: IndexedChunk[] = [];

    for (const name of vaults) {
        chunks.push(...chunksOfVault(name));
    }
    return chunks;
}

/** Chunks mais as estruturas derivadas usadas na busca. */
export type Searchable = {
    chunks: IndexedChunk[];
    lexical: LexicalIndex;
    /** Notas citadas por cada trecho, na mesma ordem de `chunks`. */
    links: string[][];
    /** Chave da nota → índices dos trechos que pertencem a ela. */
    noteIndex: Map<string, number[]>;
};

// O índice BM25 é derivado dos chunks e custa alguns milissegundos para montar.
// Guardado junto do resto para não ser reconstruído a cada pergunta.
const searchableCache = new Map<string, { key: string; searchable: Searchable }>();

/**
 * Prepara um conjunto para busca. A chave de cache combina os vaults envolvidos e a
 * data de modificação de cada índice, então qualquer reindexação invalida sozinha.
 */
export function getSearchable(vault?: string): Searchable {
    const vaults = vault === undefined ? listVaults() : [vault];

    const key = vaults
        .map((name) => {
            const path = indexPath(name);
            return `${name}:${existsSync(path) ? statSync(path).mtimeMs : 0}`;
        })
        .join("|");

    const cacheKey = vault ?? "*";
    const cached = searchableCache.get(cacheKey);
    if (cached !== undefined && cached.key === key) {
        return cached.searchable;
    }

    const chunks = loadChunks(vault);

    // Links e índice de notas são derivados do texto, então não precisam estar
    // gravados no arquivo — calcular aqui evita ter que reindexar tudo.
    const searchable: Searchable = {
        chunks,
        lexical: buildLexicalIndex(chunks.map((chunk) => chunk.text)),
        links: chunks.map((chunk) => extractLinks(chunk.text)),
        noteIndex: buildNoteIndex(chunks.map((chunk) => chunk.source)),
    };

    searchableCache.set(cacheKey, { key, searchable });
    return searchable;
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
 * Busca só por similaridade. Mantida para diagnóstico e comparação — a busca em
 * produção é `hybridSearch`.
 */
export function search(queryEmbedding: number[], chunks: IndexedChunk[], k: number): SearchHit[] {
    const scored: SearchHit[] = chunks.map((chunk) => {
        const cosine = cosineSimilarity(queryEmbedding, chunk.embedding);
        return { ...chunk, score: cosine, cosine, bm25: 0, coverage: 0 };
    });

    scored.sort((first, second) => second.score - first.score);
    return scored.slice(0, k);
}

/** Índices de `chunks` ordenados por pontuação decrescente, limitado a `depth`. */
function rankingOf(scores: number[], depth: number): number[] {
    return scores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => b.score - a.score)
        .slice(0, depth)
        .map((entry) => entry.index);
}

/** Quantos candidatos cada ranking contribui para a fusão. */
const FUSION_DEPTH = 50;

/**
 * Peso do ranking lexical na fusão, relativo ao semântico (que vale 1).
 *
 * **Padrão 0 — a busca lexical está desligada, e isso foi uma decisão medida.**
 *
 * Varrido contra `npm run eval` com 36 perguntas em três vaults, incluindo um de
 * 1.543 trechos:
 *
 * | peso | Recall@1 | Recall@3 | Recall@5 | MRR   |
 * |------|----------|----------|----------|-------|
 * | 0    | 72%      | **92%**  | **97%**  | 0,819 |
 * | 0,3  | **75%**  | 89%      | 94%      | 0,826 |
 * | 1,0  | 75%      | 86%      | 92%      | 0,813 |
 *
 * O BM25 melhora o topo e piora a profundidade. Para RAG, **Recall@5 manda**: se o
 * trecho certo não entra nos 5 que vão ao contexto, o LLM não tem como responder —
 * ao passo que sair em 1º ou 2º quase não muda a resposta final.
 *
 * E o argumento que justificava o BM25 não se sustentou: as perguntas por termo
 * exato (`bge-m3`, `GOMS`, `MIN_CHUNK_LENGTH`, `import.meta.dirname`) passaram todas
 * com a semântica pura. O `bge-m3` lida bem com termos raros.
 *
 * O código fica: o ponto cego lexical é real em outros corpora (identificadores de
 * código, códigos de erro em log). Ligar é `LEXICAL_WEIGHT=0.3 npm run eval` e medir.
 */
const LEXICAL_WEIGHT = Number(process.env["LEXICAL_WEIGHT"] ?? 0);

/**
 * Bônus somado à similaridade dos trechos citados por link. Ver `src/links.ts`.
 *
 * É um **acréscimo ao cosseno**, não um ranking paralelo. A primeira tentativa usou
 * RRF como nas outras fusões e falhou: com `k = 60`, o vão entre posições vizinhas do
 * cosseno é ~0,00003, então qualquer peso perceptível fazia o trecho citado pular
 * centenas de colocações. Pior, as notas irrelevantes citadas na mesma ata subiam
 * junto com a relevante.
 *
 * Somar ao cosseno preserva a granularidade: um trecho citado mas pouco parecido
 * continua pouco parecido. Ajustável: `GRAPH_BOOST=0.05 npm run eval`.
 */
const GRAPH_BOOST = Number(process.env["GRAPH_BOOST"] ?? 0);

/** Quantos dos melhores resultados têm seus links seguidos. */
const GRAPH_SEED_SIZE = 5;

/**
 * Desconto aplicado a notas marcadas como revistas (`status: superseded`).
 *
 * Não é censura: a nota continua recuperável, porque perguntas históricas ("por que
 * escolhemos X na época?") têm resposta legítima nela. O desconto só faz a decisão
 * **vigente** ganhar quando as duas competem — que é o caso de "o que usamos hoje?".
 * Ajustável: `SUPERSEDED_PENALTY=0.1 npm run eval`.
 */
const SUPERSEDED_PENALTY = Number(process.env["SUPERSEDED_PENALTY"] ?? 0);

/**
 * Índices dos trechos que pertencem a notas **citadas por link** pelos primeiros
 * colocados. Não é uma segunda busca: é seguir uma referência que o autor escreveu
 * de propósito.
 */
function linkedCandidates(seedIndices: number[], searchable: Searchable): Set<number> {
    const seen = new Set(seedIndices);
    const candidates = new Set<number>();

    for (const seed of seedIndices) {
        for (const link of searchable.links[seed] ?? []) {
            for (const target of searchable.noteIndex.get(link) ?? []) {
                if (!seen.has(target)) {
                    candidates.add(target);
                }
            }
        }
    }

    return candidates;
}

/**
 * Busca híbrida: combina similaridade semântica com BM25 lexical via Reciprocal
 * Rank Fusion.
 *
 * As duas se complementam por motivos opostos. O embedding acha "como deixar o app
 * bonito" numa nota sobre Tailwind, sem palavra em comum. O BM25 acha um nome de
 * função ou código de erro exato, que o embedding dilui. A fusão usa só as posições
 * de cada ranking, o que dispensa normalizar escalas incomparáveis.
 */
export type SearchFilters = {
    /** Data mínima (ISO `YYYY-MM-DD`) da nota de origem. */
    since?: string | undefined;
    until?: string | undefined;
};

export function hybridSearch(
    queryText: string,
    queryEmbedding: number[],
    searchable: Searchable,
    k: number,
    filters: SearchFilters = {},
): SearchHit[] {
    const { chunks, lexical } = searchable;
    if (chunks.length === 0) {
        return [];
    }

    // Filtro por data: aplicado ANTES da ordenação, para não desperdiçar as k vagas
    // com trechos que serão descartados depois.
    const allowed = (filters.since === undefined && filters.until === undefined)
        ? null
        : chunks.map((chunk) => withinDateRange(chunk.meta, filters.since, filters.until));

    const queryTokens = tokenize(queryText);

    const cosineScores = chunks.map((chunk, index) => (
        allowed !== null && allowed[index] === false
            ? Number.NEGATIVE_INFINITY
            : cosineSimilarity(queryEmbedding, chunk.embedding)
    ));

    // Com peso 0 o BM25 não influencia o resultado — não vale varrer o acervo à toa.
    const bm25Scores = LEXICAL_WEIGHT > 0
        ? scoreBM25(lexical, queryTokens)
        : new Array<number>(chunks.length).fill(0);

    const rankingScores = [...cosineScores];

    // Decisão revista desce na ordenação, sem sumir do acervo.
    if (SUPERSEDED_PENALTY > 0) {
        chunks.forEach((chunk, index) => {
            if (isSuperseded(chunk.meta)) {
                rankingScores[index] = (rankingScores[index] ?? 0) - SUPERSEDED_PENALTY;
            }
        });
    }

    // Expansão por grafo: soma um bônus ao cosseno dos trechos citados pelos
    // primeiros colocados, antes de qualquer ordenação.
    if (GRAPH_BOOST > 0) {
        const seeds = rankingOf(cosineScores, GRAPH_SEED_SIZE);
        for (const candidate of linkedCandidates(seeds, searchable)) {
            rankingScores[candidate] = (rankingScores[candidate] ?? 0) + GRAPH_BOOST;
        }
    }

    const rankings = [{ ranking: rankingOf(rankingScores, FUSION_DEPTH), weight: 1 }];

    if (LEXICAL_WEIGHT > 0) {
        rankings.push({ ranking: rankingOf(bm25Scores, FUSION_DEPTH), weight: LEXICAL_WEIGHT });
    }

    const fused = reciprocalRankFusion(rankings);

    return [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .flatMap(([index, score]) => {
            const chunk = chunks[index];
            if (chunk === undefined || (allowed !== null && allowed[index] === false)) {
                return [];
            }
            return [{
                ...chunk,
                score,
                cosine: cosineScores[index] ?? 0,
                bm25: bm25Scores[index] ?? 0,
                coverage: lexicalCoverage(lexical, queryTokens, index),
            }];
        });
}
