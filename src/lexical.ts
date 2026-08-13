// Busca lexical (BM25) — o complemento da busca semântica.
//
// Por que existe: embeddings entendem sentido, mas são fracos justamente onde a
// palavra exata importa — nome de função, código de erro, sigla, nome próprio. E,
// como medido em `npm run eval`, a similaridade sozinha não distingue um acerto de
// uma coincidência de vocabulário.

const K1 = 1.5;  // saturação: quanto repetir um termo ainda ajuda
const B = 0.75;  // quanto o tamanho do documento penaliza

/** Palavras frequentes demais para carregar significado numa busca. */
const STOPWORDS = new Set([
    "a", "ao", "aos", "as", "à", "às", "da", "das", "de", "do", "dos", "e", "em", "na",
    "nas", "no", "nos", "o", "os", "ou", "para", "pelo", "pela", "por", "que", "se",
    "um", "uma", "uns", "umas", "com", "sem", "sobre", "como", "qual", "quais", "quando",
    "onde", "quem", "porque", "por que", "foi", "ser", "sao", "eh", "esta", "este",
    "essa", "esse", "isso", "aquilo", "mais", "menos", "muito", "ja", "nao", "sim",
    "the", "of", "and", "to", "in", "is", "it", "for", "on", "with", "that", "this",
]);

/**
 * Quebra texto em termos comparáveis: sem acento, minúsculo, sem pontuação.
 * O plural simples é removido para "decisões" e "decisão" caírem no mesmo termo.
 */
export function tokenize(text: string): string[] {
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token))
        .map((token) => (token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token));
}

export type LexicalIndex = {
    /** Para cada documento, quantas vezes cada termo aparece. */
    termFrequencies: Map<string, number>[];
    /** Em quantos documentos cada termo aparece. */
    documentFrequency: Map<string, number>;
    documentLengths: number[];
    averageLength: number;
    documentCount: number;
};

export function buildLexicalIndex(texts: string[]): LexicalIndex {
    const termFrequencies: Map<string, number>[] = [];
    const documentFrequency = new Map<string, number>();
    const documentLengths: number[] = [];
    let totalLength = 0;

    for (const text of texts) {
        const tokens = tokenize(text);
        const frequencies = new Map<string, number>();

        for (const token of tokens) {
            frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        }
        for (const token of frequencies.keys()) {
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }

        termFrequencies.push(frequencies);
        documentLengths.push(tokens.length);
        totalLength += tokens.length;
    }

    return {
        termFrequencies,
        documentFrequency,
        documentLengths,
        averageLength: texts.length > 0 ? totalLength / texts.length : 0,
        documentCount: texts.length,
    };
}

/**
 * Pontuação BM25 de cada documento para a pergunta.
 *
 * A intuição: um termo vale mais quando é **raro** no acervo (é o que discrimina) e
 * quando aparece **várias vezes** num documento — mas com retorno decrescente, e
 * descontando documentos longos, que naturalmente contêm mais de tudo.
 */
export function scoreBM25(index: LexicalIndex, queryTokens: string[]): number[] {
    const scores = new Array<number>(index.documentCount).fill(0);
    if (index.documentCount === 0) {
        return scores;
    }

    for (const token of new Set(queryTokens)) {
        const df = index.documentFrequency.get(token);
        if (df === undefined) {
            continue;
        }

        // IDF: termo em poucos documentos pesa muito; termo em quase todos pesa pouco.
        const idf = Math.log(1 + (index.documentCount - df + 0.5) / (df + 0.5));

        for (let doc = 0; doc < index.documentCount; doc++) {
            const tf = index.termFrequencies[doc]?.get(token) ?? 0;
            if (tf === 0) {
                continue;
            }
            const length = index.documentLengths[doc] ?? 0;
            const normalization = K1 * (1 - B + (B * length) / index.averageLength);
            scores[doc] = (scores[doc] ?? 0) + idf * ((tf * (K1 + 1)) / (tf + normalization));
        }
    }

    return scores;
}

/**
 * Fração dos termos da pergunta que aparecem no documento — de 0 a 1.
 *
 * Diferente do cosseno e do BM25, este número é **absoluto e comparável entre
 * perguntas**, o que o torna útil para detectar ausência: uma pergunta sobre óleo de
 * câmbio tem cobertura baixíssima num vault de decisões técnicas, mesmo quando algum
 * verbo em comum faz a similaridade subir.
 */
export function lexicalCoverage(index: LexicalIndex, queryTokens: string[], doc: number): number {
    const unique = [...new Set(queryTokens)];
    if (unique.length === 0) {
        return 0;
    }

    const frequencies = index.termFrequencies[doc];
    if (frequencies === undefined) {
        return 0;
    }

    const present = unique.filter((token) => frequencies.has(token)).length;
    return present / unique.length;
}

/**
 * Reciprocal Rank Fusion: combina rankings usando só as POSIÇÕES, o que dispensa
 * normalizar escalas incomparáveis (cosseno vai de −1 a 1; BM25 não tem teto).
 *
 * Limitação importante: o RRF enxerga apenas ordem, nunca qualidade absoluta. Uma
 * pergunta sem nenhuma resposta boa continua tendo um "primeiro colocado" com
 * pontuação alta — por isso a detecção de ausência usa `lexicalCoverage`, não isto.
 */
export function reciprocalRankFusion(
    rankings: { ranking: number[]; weight: number }[],
    k = 60,
): Map<number, number> {
    const fused = new Map<number, number>();

    for (const { ranking, weight } of rankings) {
        ranking.forEach((docIndex, position) => {
            fused.set(docIndex, (fused.get(docIndex) ?? 0) + weight / (k + position + 1));
        });
    }

    return fused;
}
