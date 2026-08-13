// Expansão por grafo: aproveitar os links que o autor escreveu entre as notas.
//
// Por que isso é um sinal diferente dos outros: similaridade e BM25 olham só o texto
// do trecho. Um `[[link]]` é uma afirmação deliberada de que duas notas se relacionam
// — informação que nenhum embedding tem, porque ela não está no conteúdo, está na
// intenção de quem escreveu.
//
// O caso típico: a ata de reunião diz "escolhemos Postgres, detalhes em
// [[decisao-banco-de-dados]]". A pergunta casa com a ata, mas a justificativa completa
// mora na nota citada — que pode nem entrar no top-k por conta própria.

/** Wikilinks do Obsidian: [[nota]], [[nota|texto]], [[nota#secao]]. */
const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** Links markdown para outro .md: [texto](../pasta/nota.md#secao). */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gi;

/**
 * Reduz um nome de nota a uma chave comparável: sem caminho, sem extensão,
 * sem acento, em minúsculas. Assim `[[decisao-banco-de-dados]]` casa com o arquivo
 * `notes/taskflow/decisao-banco-de-dados.md`.
 */
export function noteKey(name: string): string {
    const withoutPath = name.split("/").pop() ?? name;
    return withoutPath
        .replace(/\.md$/i, "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
}

/** Notas citadas por um trecho, já normalizadas. Sem repetição. */
export function extractLinks(text: string): string[] {
    const found = new Set<string>();

    for (const pattern of [WIKILINK, MARKDOWN_LINK]) {
        for (const match of text.matchAll(pattern)) {
            const target = match[1];
            if (target !== undefined && target.trim().length > 0) {
                found.add(noteKey(target));
            }
        }
    }

    return [...found];
}

/**
 * Mapa `chave da nota → índices dos trechos daquela nota`.
 *
 * Uma nota vira vários trechos no índice; ao seguir um link, todos eles se tornam
 * candidatos, e a similaridade decide quais realmente entram.
 */
export function buildNoteIndex(sources: string[]): Map<string, number[]> {
    const byNote = new Map<string, number[]>();

    sources.forEach((source, index) => {
        const key = noteKey(source);
        const existing = byNote.get(key);
        if (existing === undefined) {
            byNote.set(key, [index]);
        } else {
            existing.push(index);
        }
    });

    return byNote;
}
