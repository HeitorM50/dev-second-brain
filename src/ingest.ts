// CLI de indexação: reconstrói o índice de todos os vaults declarados em vaults.json.
//
// A lógica de verdade mora em indexer.ts — aqui só há leitura de configuração e
// impressão de resultado, para que o servidor MCP possa reindexar exatamente igual.

import { buildVaultIndex } from "./indexer.js";
import { listVaultFiles, loadVaultConfig } from "./vaults.js";

const config = loadVaultConfig();
const vaultNames = Object.keys(config).sort();

if (vaultNames.length === 0) {
    console.error("Nenhum vault configurado. Declare as pastas de notas em vaults.json.");
    process.exit(1);
}

for (const vault of vaultNames) {
    const vaultConfig = config[vault];
    if (vaultConfig === undefined) {
        continue;
    }

    if (listVaultFiles(vault, vaultConfig).length === 0) {
        console.error(`[aviso] vault "${vault}" não tem nenhum .md — pulando.`);
        continue;
    }

    const result = await buildVaultIndex(vault, vaultConfig);

    console.log(
        `${result.vault}: ${result.fileCount} notas, ${result.chunkCount} chunks — `
        + `${result.computed} embeddados, ${result.reused} reaproveitados `
        + `(${result.elapsedSeconds.toFixed(1)}s)`,
    );

    if (result.failures.length > 0) {
        console.error(`  ⚠ ${result.failures.length} trechos falharam e ficaram fora do índice:`);
        for (const failure of result.failures.slice(0, 5)) {
            console.error(`    - ${failure}`);
        }
    }
}
