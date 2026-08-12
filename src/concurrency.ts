/**
 * Executa `fn` sobre todos os itens, com no máximo `limit` chamadas simultâneas.
 *
 * Por que não `Promise.all` em tudo: com 800 chunks isso dispararia 800 requisições
 * de uma vez, afogando o Ollama e o sistema. Aqui um punhado de "trabalhadores"
 * consome a fila em paralelo, mantendo a pressão constante.
 *
 * Medido nesta máquina (8 núcleos, bge-m3): concorrência 4 é o ponto ótimo, com
 * ganho de ~1,5x sobre sequencial. O ganho é modesto porque embeddar é limitado por
 * CPU, não por espera de rede — um único embedding já ocupa todos os núcleos.
 * Acima de 8, a disputa por processador deixa tudo mais lento.
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            const item = items[index];
            if (item === undefined) {
                return;
            }
            results[index] = await fn(item, index);
        }
    }

    const workerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}
