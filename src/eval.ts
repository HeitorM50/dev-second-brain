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
import { loadChunks, search } from "./store.js";

const TOP_K = 5;

type Question = {
    id: string;
    vault: string;
    query: string;
    /** Notas aceitas como corretas. Vazio = controle negativo: o certo é não achar nada. */
    expected: string[];
};

const questionsPath = join(import.meta.dirname, "..", "eval", "questions.json");
const { questions } = JSON.parse(readFileSync(questionsPath, "utf-8")) as { questions: Question[] };

const verbose = process.argv.includes("--verbose");

/** Posição (1-based) do primeiro acerto, ou 0 se nenhum dos k resultados serve. */
function firstHitRank(sources: string[], expected: string[]): number {
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i] ?? "";
        if (expected.some((name) => source === name || source.endsWith(`/${name}`))) {
            return i + 1;
        }
    }
    return 0;
}

let positives = 0;
let recallAt1 = 0;
let recallAt3 = 0;
let recallAt5 = 0;
let reciprocalRankSum = 0;

// Para a margem de separação: pior acerto contra melhor falso positivo.
let worstPositiveScore = Number.POSITIVE_INFINITY;
let bestNegativeScore = Number.NEGATIVE_INFINITY;

const misses: string[] = [];

for (const question of questions) {
    const chunks = loadChunks(question.vault);
    const queryEmbedding = await embed(question.query);
    const hits = search(queryEmbedding, chunks, TOP_K);
    const sources = hits.map((hit) => hit.source);
    const topScore = hits[0]?.score ?? 0;

    if (question.expected.length === 0) {
        // Controle negativo: guardamos a maior pontuação obtida por uma pergunta
        // que não tem resposta no vault.
        bestNegativeScore = Math.max(bestNegativeScore, topScore);
        if (verbose) {
            console.log(`  ${question.id.padEnd(8)} controle — maior pontuação ${topScore.toFixed(3)}`);
        }
        continue;
    }

    positives++;
    const rank = firstHitRank(sources, question.expected);

    if (rank === 1) recallAt1++;
    if (rank >= 1 && rank <= 3) recallAt3++;
    if (rank >= 1 && rank <= 5) recallAt5++;
    reciprocalRankSum += rank === 0 ? 0 : 1 / rank;

    if (rank === 1) {
        worstPositiveScore = Math.min(worstPositiveScore, topScore);
    }
    if (rank === 0) {
        misses.push(`${question.id}: "${question.query}" — esperado ${question.expected.join(" ou ")}, veio ${sources[0] ?? "nada"}`);
    }

    if (verbose) {
        const mark = rank === 0 ? "✗" : rank === 1 ? "✓" : `→${rank}`;
        console.log(`  ${question.id.padEnd(8)} ${mark.padEnd(3)} ${topScore.toFixed(3)}  ${question.query}`);
    }
}

const percent = (value: number): string => `${((value / positives) * 100).toFixed(0)}%`;
const margin = worstPositiveScore - bestNegativeScore;

console.log(`\n${positives} perguntas com resposta esperada, ${questions.length - positives} controles negativos\n`);
console.log(`  Recall@1   ${percent(recallAt1).padStart(4)}   (${recallAt1}/${positives}) — nota certa em primeiro`);
console.log(`  Recall@3   ${percent(recallAt3).padStart(4)}   (${recallAt3}/${positives})`);
console.log(`  Recall@5   ${percent(recallAt5).padStart(4)}   (${recallAt5}/${positives}) — chegou ao contexto do LLM`);
console.log(`  MRR        ${(reciprocalRankSum / positives).toFixed(3)}        — 1,0 seria tudo em primeiro`);
console.log(
    `\n  Separação  ${margin >= 0 ? "+" : ""}${margin.toFixed(3)}       `
    + `— pior acerto ${worstPositiveScore.toFixed(3)} vs. melhor falso ${bestNegativeScore.toFixed(3)}`,
);

if (margin > 0) {
    const threshold = (worstPositiveScore + bestNegativeScore) / 2;
    console.log(`             existe limiar que separa os dois grupos (ex.: ${threshold.toFixed(3)})`);
} else {
    console.log(`             ⚠ nenhum limiar separa acertos de ruído — a busca não sabe dizer "não sei"`);
}

if (misses.length > 0) {
    console.log(`\n  ${misses.length} pergunta(s) sem acerto no top ${TOP_K}:`);
    for (const miss of misses) {
        console.log(`    - ${miss}`);
    }
}
