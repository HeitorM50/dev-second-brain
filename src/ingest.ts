import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const MIN_CHUNK_LENGTH = 120;

function mergeSmallChunks(chunks: string[], minLength: number): string[] {
    const merged: string[] = [];
    
    for (const chunk of chunks){
        const previous = merged[merged.length -1];
        if (chunk.length < minLength && previous !== undefined){
            merged[merged.length -1] = `${previous}\n\n${chunk}`;
        } else {
            merged.push(chunk);
        }
    }
    return merged;
}


const files = readdirSync("notes");
const mdFiles = files.filter((name) => name.endsWith (".md"));

for (const name of mdFiles) {
    const fullPath = join("notes", name);
    const content = readFileSync(fullPath, "utf-8");
    const rawchunks = chunkByHeading(content);
    const chunks = mergeSmallChunks(rawchunks, MIN_CHUNK_LENGTH);
    console.log(`\n===== ${name} (${chunks.length} chunks) ======`);
    for (const chunk of chunks){
        const chunkWithSource = `Fonte: ${name}\n${chunk}`;
        console.log("--- chunk ---");
        console.log(chunkWithSource);
    }
}


