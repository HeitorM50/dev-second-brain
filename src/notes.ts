// Criação de notas a partir de conversa — a metade de "escrita" do segundo cérebro.
//
// A metade de consulta (buscar) só tem valor se escrever for barato. Aqui a nota
// nasce de uma frase dita ao Claude Code, sem abrir editor nem pensar em nome de
// arquivo.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { resolveWriteDir, type VaultConfig } from "./vaults.js";

const MAX_SLUG_LENGTH = 60;

/**
 * Transforma um título em nome de arquivo seguro.
 *
 * A sanitização não é cosmética: o título vem do modelo, e algo como
 * "../../.ssh/authorized_keys" escreveria fora da pasta do vault. Sobrevivem apenas
 * letras sem acento, números e hífens.
 */
export function slugify(title: string): string {
    const slug = title
        .normalize("NFD")                    // separa letra e acento ("ç" → "c" + cedilha)
        .replace(/[\u0300-\u036f]/g, "")     // remove os acentos, agora soltos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")         // tudo que não é letra/número vira hífen
        .replace(/^-+|-+$/g, "")             // sem hífen sobrando nas pontas
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/, "");

    return slug.length > 0 ? slug : "nota";
}

/** Escolhe um nome livre, acrescentando sufixo se já existir arquivo com aquele nome. */
function availablePath(dir: string, slug: string): string {
    let candidate = join(dir, `${slug}.md`);
    let counter = 2;

    while (existsSync(candidate)) {
        candidate = join(dir, `${slug}-${counter}.md`);
        counter++;
    }
    return candidate;
}

export type SavedNote = {
    /** Caminho absoluto do arquivo criado. */
    path: string;
    /** Caminho relativo à pasta de escrita — é assim que a nota será citada. */
    label: string;
};

export type SaveNoteError = { error: string };

export function saveNote(
    vault: string,
    config: VaultConfig,
    title: string,
    content: string,
): SavedNote | SaveNoteError {
    const writeDir = resolveWriteDir(config);

    if (writeDir === null) {
        return {
            error: `O vault "${vault}" não declara onde criar notas. Acrescente "writeTo" `
                + `à configuração dele em vaults.json, apontando para uma das pastas de "sources" `
                + `— de preferência uma pasta pessoal, não o repositório de um projeto de trabalho.`,
        };
    }

    const filePath = availablePath(writeDir, slugify(title));

    // Cinto e suspensório: mesmo com o slug sanitizado, confirma que o caminho final
    // está de fato dentro da pasta de escrita antes de gravar qualquer coisa.
    const insideWriteDir = relative(resolve(writeDir), resolve(filePath));
    if (insideWriteDir.startsWith("..") || insideWriteDir.includes(`..${sep}`)) {
        return { error: "Caminho de destino inválido — a nota ficaria fora da pasta do vault." };
    }

    const today = new Date().toISOString().slice(0, 10);
    const body = content.trim();

    // Front-matter: metadados que a busca semântica não deduz do texto — data para
    // filtrar por período, status para marcar decisão revista depois.
    const frontmatter = [
        "---",
        `data: ${today}`,
        `projeto: ${vault}`,
        "status: ativo",
        "---",
        "",
    ].join("\n");

    const markdown = `${frontmatter}\n# ${title.trim()}\n\n_Registrado em ${today}._\n\n${body}\n`;

    mkdirSync(writeDir, { recursive: true });
    writeFileSync(filePath, markdown, "utf-8");

    return { path: filePath, label: relative(writeDir, filePath) };
}
