// Transforma texto em vetor, chamando o Ollama que roda localmente.
// Isolado num módulo próprio porque tanto a indexação quanto a busca precisam dele.

const OLLAMA_URL = "http://localhost:11434/api/embeddings";

// bge-m3: modelo multilíngue (1024 dimensões). Substituiu o nomic-embed-text,
// que é treinado em inglês e não separava bem os assuntos das notas em português.
// Trocar de modelo invalida o índice inteiro — rodar `npm run ingest` de novo.
export const EMBEDDING_MODEL = "bge-m3";

type EmbeddingResponse = {
    embedding: number[];
};

export async function embed(text: string): Promise<number[]> {
    const response = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            prompt: text,
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama respondeu ${response.status}`);
    }

    const data = (await response.json()) as EmbeddingResponse;
    return data.embedding;
}
