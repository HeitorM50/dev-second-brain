// Passo 5, primeira metade: recebe uma pergunta e mostra os trechos mais
// relevantes. Ainda sem LLM — aqui dá para ver a busca crua.
//
// Uso:  npm run ask -- "sua pergunta"                  (busca em todos os vaults)
//       npm run ask -- --vault taskflow "sua pergunta" (busca em um vault só)

import { embed } from "./embed.js";
import { listVaults, loadChunks, search } from "./store.js";

const HITS_TO_SHOW = 3;

const args = process.argv.slice(2);

let vault: string | undefined;
if (args[0] === "--vault") {
    vault = args[1];
    args.splice(0, 2);
}

const question = args.join(" ").trim();

if (question.length === 0) {
    console.error('Uso: npm run ask -- [--vault <nome>] "sua pergunta"');
    console.error(`Vaults disponíveis: ${listVaults().join(", ") || "(nenhum — rode npm run ingest)"}`);
    process.exit(1);
}

const chunks = loadChunks(vault);

if (chunks.length === 0) {
    console.error(
        vault === undefined
            ? "Nenhum índice encontrado. Rode `npm run ingest` primeiro."
            : `Vault "${vault}" não tem índice. Disponíveis: ${listVaults().join(", ")}`,
    );
    process.exit(1);
}

const questionEmbedding = await embed(question);
const hits = search(questionEmbedding, chunks, HITS_TO_SHOW);

const scope = vault === undefined ? `todos os vaults (${listVaults().join(", ")})` : `vault ${vault}`;
console.log(`\nPergunta: ${question}`);
console.log(`Buscando em ${scope} — ${chunks.length} chunks\n`);

for (const hit of hits) {
    console.log(`[${hit.score.toFixed(3)}] ${hit.vault}/${hit.source}`);
    // Pula a primeira linha (o carimbo "Fonte:") e mostra um trecho do conteúdo.
    const preview = hit.text.split("\n").slice(1).join("\n").trim().slice(0, 180);
    console.log(`${preview}\n`);
}
