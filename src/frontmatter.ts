// Front-matter das notas: metadados que a busca semântica não sabe deduzir.
//
// "O que decidimos em julho?" é pergunta de DATA, não de significado — nenhum
// embedding responde isso de forma confiável. E "esta decisão ainda vale?" depende de
// um estado que só quem escreveu pode declarar.
//
// Formato aceito (subconjunto de YAML, deliberadamente pequeno para não trazer uma
// dependência nova):
//
//     ---
//     data: 2026-08-13
//     projeto: taskflow
//     tags: [banco, decisao]
//     status: ativo | superseded
//     superseded_by: nome-da-nota-nova
//     supersedes: nome-da-nota-antiga
//     ---

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type NoteMeta = {
    /** ISO `YYYY-MM-DD`. Ausente quando a nota não declara. */
    date?: string | undefined;
    project?: string | undefined;
    tags?: string[] | undefined;
    /** "ativo" por padrão; "superseded" quando a decisão foi revista. */
    status?: string | undefined;
    /** Nota que substitui esta. */
    supersededBy?: string | undefined;
};

export type ParsedNote = {
    meta: NoteMeta;
    /** Conteúdo sem o bloco de front-matter — é o que vai para o embedding. */
    body: string;
};

function parseValue(raw: string): string | string[] {
    const value = raw.trim();

    if (value.startsWith("[") && value.endsWith("]")) {
        return value
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim().replace(/^["']|["']$/g, ""))
            .filter((item) => item.length > 0);
    }
    return value.replace(/^["']|["']$/g, "");
}

/**
 * Separa metadados e corpo. Sem front-matter, devolve o texto intacto e metadados
 * vazios — notas antigas continuam funcionando sem migração.
 */
export function parseFrontmatter(content: string): ParsedNote {
    const match = FRONTMATTER.exec(content);
    if (match === null || match[1] === undefined) {
        return { meta: {}, body: content };
    }

    const meta: NoteMeta = {};

    for (const line of match[1].split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator === -1 || line.trimStart().startsWith("#")) {
            continue;
        }

        const key = line.slice(0, separator).trim().toLowerCase();
        const value = parseValue(line.slice(separator + 1));

        if (key === "data" || key === "date") {
            meta.date = typeof value === "string" ? value : undefined;
        } else if (key === "projeto" || key === "project") {
            meta.project = typeof value === "string" ? value : undefined;
        } else if (key === "tags") {
            meta.tags = Array.isArray(value) ? value : [value];
        } else if (key === "status") {
            meta.status = typeof value === "string" ? value : undefined;
        } else if (key === "superseded_by" || key === "substituida_por") {
            meta.supersededBy = typeof value === "string" ? value : undefined;
        }
    }

    return { meta, body: content.slice(match[0].length) };
}

/** A nota foi marcada como revista/substituída? */
export function isSuperseded(meta: NoteMeta): boolean {
    return meta.status === "superseded" || meta.supersededBy !== undefined;
}

/**
 * A nota cai dentro da janela de datas? Notas **sem data declarada nunca são
 * filtradas** — descartá-las faria um filtro de recorte esconder silenciosamente
 * todo o acervo antigo, que é a maior parte dele.
 */
export function withinDateRange(meta: NoteMeta, since?: string, until?: string): boolean {
    if (meta.date === undefined) {
        return true;
    }
    if (since !== undefined && meta.date < since) {
        return false;
    }
    if (until !== undefined && meta.date > until) {
        return false;
    }
    return true;
}
