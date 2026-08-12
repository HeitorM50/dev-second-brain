// Passos 1 a 4 do pipeline: ler as notas, fatiar, embeddar e salvar o índice.
//
// Cada subpasta de notes/ é um vault (um projeto) e gera seu próprio índice.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { embed, EMBEDDING_MODEL } from "./embed.js";
import { hashText, loadEmbeddingCache, saveIndex, type IndexedChunk } from "./store.js";

const NOTES_DIR = "notes";
const MIN_CHUNK_LENGTH = 120;

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

/** Cada subpasta de notes/ é um vault. */
function listVaultDirs(): string[] {
    return readdirSync(NOTES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

async function ingestVault(vault: string): Promise<void> {
    const vaultDir = join(NOTES_DIR, vault);
    const mdFiles = readdirSync(vaultDir).filter((name) => name.endsWith(".md"));

    // Embeddings já calculados numa execução anterior, indexados pelo hash do texto.
    // Vem vazio se o índice não existe ou se foi gerado por outro modelo.
    const cache = loadEmbeddingCache(vault, EMBEDDING_MODEL);

    const chunksOfVault: IndexedChunk[] = [];
    const startedAt = Date.now();
    let reused = 0;
    let computed = 0;

    for (const name of mdFiles) {
        const content = readFileSync(join(vaultDir, name), "utf-8");
        const rawChunks = chunkByHeading(content);
        const chunks = mergeSmallChunks(rawChunks, MIN_CHUNK_LENGTH);

        for (const chunk of chunks){
            const text = `Fonte: ${name}\n${chunk}`;
            const hash = hashText(text);

            // O trabalho caro só acontece quando o texto é novo ou mudou.
            const cached = cache.get(hash);
            let embedding: number[];
            if (cached !== undefined) {
                embedding = cached;
                reused++;
            } else {
                embedding = await embed(text);
                computed++;
            }

            chunksOfVault.push({ vault, source: name, text, hash, embedding });
        }
    }

    saveIndex(vault, chunksOfVault, EMBEDDING_MODEL);

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(
        `${vault}: ${mdFiles.length} notas, ${chunksOfVault.length} chunks — `
        + `${computed} embeddados, ${reused} reaproveitados (${elapsed.toFixed(1)}s)`,
    );
}

const vaults = listVaultDirs();

if (vaults.length === 0) {
    console.error(`Nenhum vault encontrado. Crie uma subpasta em ${NOTES_DIR}/ com suas notas.`);
    process.exit(1);
}

for (const vault of vaults) {
    await ingestVault(vault);
}
