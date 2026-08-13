// Avaliação da qualidade da busca.
//
// Sem isto, "a busca melhorou?" é opinião. Aqui vira número: roda um conjunto fixo de
// perguntas com a nota correta esperada e reporta métricas comparáveis entre execuções.
//
// Uso:  npm run eval
//       npm run eval -- --verbose    (mostra o resultado pergunta a pergunta)

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { embed } from "./embed.js";
import { isSuperseded } from "./frontmatter.js";
import { getSearchable, hybridSearch, search, type SearchHit } from "./store.js";

const TOP_K = 5;

type Question = {
    id: string;
    /** Omitido = busca cruzada em todos os vaults, como o Claude faz quando não sabe o projeto. */
    vault?: string;
    query: string;
    /** Filtro de data, como o Claude passaria numa pergunta sobre período. */
    since?: string;
    until?: string;
    /** O primeiro resultado deve vir marcado como decisão revista. */
    expectSuperseded?: boolean;
    /** Notas aceitas como corretas. Vazio = controle negativo: o certo é não achar nada. */
    expected: string[];
};

const questionsPath = join(import.meta.dirname, "..", "eval", "questions.json");
const { questions } = JSON.parse(readFileSync(questionsPath, "utf-8")) as { questions: Question[] };

const verbose = process.argv.includes("--verbose");

/** Posição (1-based) do primeiro acerto, ou 0 se nenhum dos k resultados serve. */
function firstHitRank(hits: SearchHit[], expected: string[]): number {
    for (let i = 0; i < hits.length; i++) {
        const source = hits[i]?.source ?? "";
        if (expected.some((name) => source === name || source.endsWith(`/${name}`))) {
            return i + 1;
        }
    }
    return 0;
}

type Metrics = {
    recallAt1: number;
    recallAt3: number;
    recallAt5: number;
    mrr: number;
    /** Menor valor do sinal entre acertos em 1º lugar. */
    worstPositive: number;
    /** Maior valor do sinal entre perguntas sem resposta. */
    bestNegative: number;
    misses: string[];
};

function emptyMetrics(): Metrics {
    return {
        recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0,
        worstPositive: Number.POSITIVE_INFINITY,
        bestNegative: Number.NEGATIVE_INFINITY,
        misses: [],
    };
}

/** `signal` escolhe qual número usar para medir separação: cosseno ou cobertura. */
function record(
    metrics: Metrics,
    question: Question,
    hits: SearchHit[],
    signal: (hit: SearchHit) => number,
): void {
    const top = hits[0];
    const topSignal = top === undefined ? 0 : signal(top);

    if (question.expected.length === 0) {
        metrics.bestNegative = Math.max(metrics.bestNegative, topSignal);
        return;
    }

    const rank = firstHitRank(hits, question.expected);
    if (rank === 1) metrics.recallAt1++;
    if (rank >= 1 && rank <= 3) metrics.recallAt3++;
    if (rank >= 1 && rank <= 5) metrics.recallAt5++;
    metrics.mrr += rank === 0 ? 0 : 1 / rank;

    if (rank === 1) {
        metrics.worstPositive = Math.min(metrics.worstPositive, topSignal);
    } else if (rank === 0) {
        metrics.misses.push(
            `${question.id}: "${question.query}" — esperado ${question.expected.join(" ou ")}, `
            + `veio ${hits[0]?.source ?? "nada"}`,
        );
    }
}

let supersededChecks = 0;
let supersededDetected = 0;
const supersededMisses: string[] = [];

const semantic = emptyMetrics();
const hybrid = emptyMetrics();
const hybridCoverage = emptyMetrics();
let positives = 0;

for (const question of questions) {
    const searchable = getSearchable(question.vault);
    if (searchable.chunks.length === 0) {
        console.error(`[aviso] ${question.id}: vault "${question.vault}" sem índice — pulando.`);
        continue;
    }
    const queryEmbedding = await embed(question.query);

    const filters = { since: question.since, until: question.until };
    const semanticHits = search(queryEmbedding, searchable.chunks, TOP_K);
    const hybridHits = hybridSearch(question.query, queryEmbedding, searchable, TOP_K, filters);

    if (question.expectSuperseded === true) {
        // A nota revista pode legitimamente não vir em 1º — o que importa é que,
        // aparecendo entre os resultados, ela venha sinalizada.
        supersededChecks++;
        const rank = firstHitRank(hybridHits, question.expected);
        const hit = rank > 0 ? hybridHits[rank - 1] : undefined;
        if (hit !== undefined && isSuperseded(hit.meta)) {
            supersededDetected++;
        } else {
            supersededMisses.push(
                `${question.id}: "${question.query}" — `
                + (rank === 0 ? "nota nem apareceu no top-k" : "apareceu sem a marcação"),
            );
        }
    }

    if (question.expected.length > 0) {
        positives++;
    }

    record(semantic, question, semanticHits, (hit) => hit.cosine);
    record(hybrid, question, hybridHits, (hit) => hit.cosine);
    record(hybridCoverage, question, hybridHits, (hit) => hit.coverage);

    if (verbose) {
        const mark = (hits: SearchHit[]): string => {
            if (question.expected.length === 0) return "ctrl";
            const rank = firstHitRank(hits, question.expected);
            return rank === 0 ? " ✗ " : rank === 1 ? " ✓ " : `→${rank} `;
        };
        console.log(
            `  ${question.id.padEnd(8)} sem:${mark(semanticHits)} hib:${mark(hybridHits)} `
            + `cob:${(hybridHits[0]?.coverage ?? 0).toFixed(2)}  ${question.query}`,
        );
    }
}

const percent = (value: number): string => `${((value / positives) * 100).toFixed(0)}%`;
const negatives = questions.length - positives;

console.log(`\n${positives} perguntas com resposta esperada, ${negatives} controles negativos\n`);
console.log("                    semântica   híbrida");
console.log(`  Recall@1          ${percent(semantic.recallAt1).padStart(8)}  ${percent(hybrid.recallAt1).padStart(8)}`);
console.log(`  Recall@3          ${percent(semantic.recallAt3).padStart(8)}  ${percent(hybrid.recallAt3).padStart(8)}`);
console.log(`  Recall@5          ${percent(semantic.recallAt5).padStart(8)}  ${percent(hybrid.recallAt5).padStart(8)}`);
console.log(`  MRR               ${(semantic.mrr / positives).toFixed(3).padStart(8)}  ${(hybrid.mrr / positives).toFixed(3).padStart(8)}`);

const gap = (m: Metrics): number => m.worstPositive - m.bestNegative;

console.log("\n  Separação — consegue distinguir acerto de ruído?\n");
for (const [label, metrics] of [
    ["cosseno (semântica)", semantic],
    ["cosseno (híbrida)  ", hybrid],
    ["cobertura lexical  ", hybridCoverage],
] as const) {
    const value = gap(metrics);
    const status = value > 0 ? "✓ separa" : "✗ não separa";
    console.log(
        `    ${label}  ${value >= 0 ? "+" : ""}${value.toFixed(3)}  ${status}`
        + `   (pior acerto ${metrics.worstPositive.toFixed(3)} vs. melhor falso ${metrics.bestNegative.toFixed(3)})`,
    );
}

if (supersededChecks > 0) {
    const ok = supersededDetected === supersededChecks;
    console.log(
        `\n  Decisões revistas   ${supersededDetected}/${supersededChecks} sinalizadas  `
        + `${ok ? "✓" : "✗ o aviso não apareceu"}`,
    );
    for (const miss of supersededMisses) {
        console.log(`    - ${miss}`);
    }
}

if (hybrid.misses.length > 0) {
    console.log(`\n  ${hybrid.misses.length} pergunta(s) sem acerto no top ${TOP_K} (híbrida):`);
    for (const miss of hybrid.misses) {
        console.log(`    - ${miss}`);
    }
}
