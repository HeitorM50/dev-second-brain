// Registro de vaults: quais pastas alimentam cada projeto.
//
// As notas NÃO precisam morar dentro deste repositório. Um vault pode apontar para
// a pasta de documentação de outro projeto, indexando-a onde ela já está — sem cópia
// e sem risco de a cópia envelhecer.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type VaultConfig = {
    /** Pastas que alimentam este vault. Relativas à raiz do projeto ou absolutas. */
    sources: string[];
    /** Trechos de caminho a ignorar, ex.: ["changelog", "api-reference"]. */
    exclude?: string[];
    /**
     * Onda notas novas são criadas por `save_note`. Precisa ser declarada: sem isto,
     * uma anotação pessoal poderia acabar dentro do repositório de trabalho de um
     * cliente. Deve ser uma das `sources`, para a nota ficar indexada.
     */
    writeTo?: string;
};

type VaultsFile = {
    vaults: Record<string, VaultConfig>;
};

/** Pastas nunca indexadas, independentemente da configuração. */
const ALWAYS_SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "data"]);

const PROJECT_ROOT = join(import.meta.dirname, "..");
const CONFIG_PATH = join(PROJECT_ROOT, "vaults.json");

export function loadVaultConfig(): Record<string, VaultConfig> {
    if (!existsSync(CONFIG_PATH)) {
        return {};
    }
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as VaultsFile;
    return parsed.vaults ?? {};
}

/** Caminhos configurados são relativos à raiz do projeto, salvo se já forem absolutos. */
function resolveSource(source: string): string {
    return isAbsolute(source) ? source : resolve(PROJECT_ROOT, source);
}

/**
 * Pasta onde novas notas do vault devem ser criadas, já resolvida para caminho
 * absoluto. Devolve null quando o vault não declara `writeTo` — nesse caso a
 * escrita é recusada, em vez de escolher uma pasta por conta própria.
 */
export function resolveWriteDir(config: VaultConfig): string | null {
    if (config.writeTo === undefined) {
        return null;
    }
    return resolveSource(config.writeTo);
}

export type MarkdownFile = {
    /** Caminho absoluto, para leitura. */
    path: string;
    /** Caminho legível usado como citação da fonte, ex.: "adr/0003-banco.md". */
    label: string;
};

/** Percorre uma pasta recursivamente coletando arquivos .md. */
function walkMarkdown(dir: string, rootForLabel: string, exclude: string[]): MarkdownFile[] {
    const found: MarkdownFile[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ALWAYS_SKIP.has(entry.name) || entry.name.startsWith(".")) {
            continue;
        }

        const fullPath = join(dir, entry.name);
        const label = relative(rootForLabel, fullPath);

        if (exclude.some((pattern) => label.includes(pattern))) {
            continue;
        }

        if (entry.isDirectory()) {
            found.push(...walkMarkdown(fullPath, rootForLabel, exclude));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push({ path: fullPath, label });
        }
    }

    return found;
}

/**
 * Todos os arquivos markdown que alimentam um vault, de todas as suas fontes.
 * Fontes inexistentes são avisadas em stderr e ignoradas — um projeto pode ter
 * sido movido ou apagado sem que isso derrube a indexação dos demais.
 */
export function listVaultFiles(vault: string, config: VaultConfig): MarkdownFile[] {
    const exclude = config.exclude ?? [];

    // Coleta por fonte, rotulando relativo à própria fonte — o caminho mais curto
    // e legível possível para a citação.
    const perSource: { dirName: string; files: MarkdownFile[] }[] = [];

    for (const source of config.sources) {
        const dir = resolveSource(source);

        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            console.error(`[aviso] vault "${vault}": fonte não encontrada — ${dir}`);
            continue;
        }

        perSource.push({ dirName: basename(dir), files: walkMarkdown(dir, dir, exclude) });
    }

    // Só desempata quando precisa: um rótulo que aparece em mais de uma fonte
    // (dois README.md, por exemplo) ganha o nome da pasta de origem como prefixo.
    const labelCount = new Map<string, number>();
    for (const source of perSource) {
        for (const file of source.files) {
            labelCount.set(file.label, (labelCount.get(file.label) ?? 0) + 1);
        }
    }

    const files: MarkdownFile[] = [];
    for (const source of perSource) {
        for (const file of source.files) {
            const isAmbiguous = (labelCount.get(file.label) ?? 0) > 1;
            files.push({
                path: file.path,
                label: isAmbiguous ? join(source.dirName, file.label) : file.label,
            });
        }
    }

    return files.sort((a, b) => a.label.localeCompare(b.label));
}
