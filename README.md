# dev-second-brain

**AI Second Brain for Developers** — um segundo cérebro que preserva o contexto de projetos e responde, em linguagem natural, perguntas sobre decisões passadas.

---

## Visão geral

No dia a dia de desenvolvimento, contexto se perde com facilidade:

- Decisões técnicas tomadas semanas atrás cujo motivo ninguém mais lembra.
- Discussões relevantes que se dissolvem no histórico de mensagens.
- Justificativas de escolhas ("por que adotamos essa biblioteca?") que nunca ficam documentadas.

Este projeto aponta para uma pasta de notas em markdown, constrói um índice semântico e permite consultá-las por significado — respondendo com citação da nota de origem.

**Como se usa na prática:** o segundo cérebro é exposto ao Claude Code como um servidor MCP. Você pergunta em linguagem natural, de dentro de qualquer projeto, e ele recupera os trechos relevantes e redige a resposta.

> _"o que a gente decidiu sobre o banco no TaskFlow e por quê?"_

## Como funciona

```
notas .md  →  fatiar por seção  →  embeddar (Ollama)  →  índice JSON por vault
                                                              ↓
Claude Code  ←  redige com citação  ←  trechos relevantes  ←  busca por cosseno
```

1. **Ingerir** — lê os `.md` de cada vault em `notes/`.
2. **Fatiar** — quebra cada nota por seção, fundindo trechos pequenos.
3. **Embeddar** — cada trecho vira um vetor de 1024 dimensões, via Ollama local.
4. **Indexar** — vetores e textos são gravados em `data/vaults/<nome>.json`.
5. **Consultar** — a pergunta é embeddada, comparada por similaridade de cosseno, e os melhores trechos vão para o Claude Code redigir a resposta.

Embeddings e busca rodam **inteiramente na máquina**. Nenhuma nota é enviada para serviço externo durante a indexação.

## Stack

| Camada | Tecnologia | Por quê |
|---|---|---|
| Núcleo | TypeScript / Node (ESM, `tsx`) | Reaproveitável por qualquer interface futura |
| Embeddings | Ollama + `bge-m3` (1024 dim.) | Local, grátis e multilíngue — modelos só de inglês falham com notas em português |
| Índice | Arquivo JSON por vault + varredura linear | Zero dependências e inspecionável; isolado atrás de `src/store.ts` para troca futura |
| Interface / geração | Claude Code via **MCP** | Sem chave de API e disponível de qualquer pasta |

As decisões de arquitetura, com alternativas e trade-offs, estão em [`docs/arquitetura.md`](docs/arquitetura.md).

## Instalação

**Pré-requisitos:** Node 20+ e [Ollama](https://ollama.com).

```bash
# 1. Ollama e o modelo de embedding
sudo systemctl start ollama
ollama pull bge-m3

# 2. Dependências do projeto
npm install

# 3. Construir o índice
npm run ingest
```

**Registrar no Claude Code** (escopo de usuário, disponível em qualquer pasta):

```bash
claude mcp add -s user dev-second-brain -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/src/mcp-server.ts"
```

Confira com `claude mcp list` — deve aparecer como `✔ Connected`.

## Uso

### Pelo Claude Code (principal)

Basta perguntar em linguagem natural. O Claude decide sozinho quando acionar a busca:

> _"em quais projetos eu já considerei usar Postgres?"_

Ferramentas expostas:

| Ferramenta | O que faz |
|---|---|
| `search_notes(query, vault?, limit?)` | Busca semântica. Sem `vault`, cruza todos os projetos |
| `save_note(vault, title, content)` | Cria uma nota a partir da conversa, indexada na hora |
| `list_vaults()` | Lista os projetos indexados |

Para registrar algo, basta dizer:

> _"anota aí que decidimos usar sessão própria em vez de Auth0, por causa do custo por usuário"_

A nota vira um `.md` estruturado na pasta `writeTo` do vault e fica buscável imediatamente. O índice também se atualiza sozinho quando você edita uma nota pelo editor — não é preciso rodar `npm run ingest` a cada mudança.

### Pelo terminal (depuração)

```bash
npm run ingest                                    # reconstrói os índices
npm run ask -- "sua pergunta"                     # busca em todos os vaults
npm run ask -- --vault taskflow "sua pergunta"    # busca em um projeto só
```

## Vaults — um por projeto

Um **vault** é a memória isolada de um projeto. O isolamento é questão de corretude, não só de organização: perguntar _"por que escolhemos Postgres?"_ com tudo junto pode trazer, de projetos diferentes, uma nota que **adotou** e outra que **descartou** a mesma tecnologia.

**As notas não precisam morar aqui.** O arquivo `vaults.json` declara quais pastas alimentam cada vault — elas podem estar em qualquer lugar do disco. Só o índice derivado fica em `data/vaults/`.

```json
{
  "vaults": {
    "meu-projeto": {
      "sources": ["/home/heitor/Projects/meu-projeto/docs"]
    }
  }
}
```

### Como adicionar um projeto

Sempre o mesmo processo: **declarar a fonte → reindexar.**

```bash
# 1. edite vaults.json acrescentando o vault
# 2. reconstrua o índice (só o que for novo é embeddado)
npm run ingest
```

Escolha um nome curto e em minúsculas — é por ele que você vai se referir ao projeto ao conversar com o Claude.

### Qual configuração usar

**Projeto que já tem documentação** — aponte para a pasta existente. Nada é copiado; os arquivos continuam sendo editados e versionados onde sempre estiveram.

```json
"crianex": { "sources": ["/home/heitor/Projects/crianex/docs"] }
```

**Projeto sem documentação, ou anotações que não devem ir para o repositório do trabalho** — crie uma pasta aqui dentro e escreva nela.

```json
"cliente-x": {
  "sources": ["notes/cliente-x"],
  "writeTo": "notes/cliente-x"
}
```

**Os dois ao mesmo tempo** — documentação oficial do projeto mais anotações privadas suas, consultáveis juntas:

```json
"crianex": {
  "sources": [
    "/home/heitor/Projects/crianex/docs",
    "notes/crianex"
  ],
  "writeTo": "notes/crianex"
}
```

### `writeTo` — onde as notas novas nascem

O `save_note` só escreve na pasta declarada em `writeTo`, e **recusa** criar a nota se ela não existir na configuração. É proposital: sem essa declaração, uma anotação pessoal poderia acabar dentro do repositório de trabalho de um cliente e virar um commit indesejado.

Aponte o `writeTo` para uma pasta pessoal — normalmente `notes/<projeto>` — mesmo quando o vault também indexa a documentação de um repositório externo.

### Filtrando ruído

Pastas com muito markdown irrelevante (changelog gerado, referência de API) diluem a busca. Use `exclude` — qualquer caminho que contenha um dos trechos é ignorado:

```json
"meu-projeto": {
  "sources": ["/home/heitor/Projects/meu-projeto"],
  "exclude": ["CHANGELOG", "api-reference", "vendor"]
}
```

`node_modules`, `.git`, `dist`, `build` e pastas ocultas já são ignorados sempre.

### Reindexação

É incremental: cada trecho tem um hash do seu texto, e só o que mudou é recalculado. Reindexar um projeto de 1.500 trechos sem alterações custa menos de um segundo.

## Status

MVP concluído. O pipeline completo funciona ponta a ponta, com separação por vault e indexação incremental.

Em aberto: captura assistida de notas (`save_note`), reindexação automática, conjunto de avaliação da qualidade de busca e busca híbrida. Ver [`docs/arquitetura.md`](docs/arquitetura.md) e [`docs/mvp.md`](docs/mvp.md).

---

Desenvolvido por [@HeitorM50](https://github.com/HeitorM50).
