# MVP — dev-second-brain

Documento vivo com as decisões e o escopo da primeira versão. Atualize conforme o projeto evolui.

_Última atualização: 2026-08-12_

> Visão de cima (diagramas do sistema, fases e roadmap): **`docs/arquitetura.md`**.
> Este documento aqui guarda as **decisões** e o **ponto exato** onde retomar.

---

## Objetivo do MVP

Apontar a ferramenta para uma pasta de notas em markdown, construir um índice
semântico dessas notas e permitir **perguntas em linguagem natural** sobre elas,
recebendo respostas que **citam a nota de origem**.

Em uma frase: _"tornar minhas notas pessoais consultáveis em linguagem natural,
com citação da fonte."_

---

## Decisões tomadas

| Tema | Decisão | Por quê |
|---|---|---|
| Arquitetura | **Caminho C — híbrido** | Os arquivos `.md` são a fonte da verdade (legíveis, portáteis, versionáveis com git, lidos direto pelo Claude); um índice vetorial é **derivado** deles para a busca semântica. Evita reconstruir o que o Obsidian já dá (grafo, links, editor) e mantém o foco de aprendizado no RAG. |
| Primeira fonte | **Notas pessoais (markdown)** | Menor atrito de captura — os arquivos já existem/são escritos por mim. Conversas e GitHub ficam para depois (atrito de captura alto). |
| Linguagem | **TypeScript / Node** | A stack planejada é Next.js; escrever o núcleo em TS permite reaproveitar tudo na aplicação depois. |
| Formato inicial | **CLI autônomo primeiro**, depois integrar ao Next.js | Construir o núcleo do RAG como script de terminal foca 100% no conceito, sem o ruído de montar UI web junto. A mesma lógica será chamada pela app Next.js mais tarde (só muda quem aciona). |
| Chunking (passo 2) | **Por seção (títulos markdown)** + fusão de chunks pequenos + carimbo de fonte | As notas já são estruturadas em `##`; cada seção vira um chunk coerente, com o título como contexto. Chunks abaixo de ~120 caracteres são fundidos ao anterior (`MIN_CHUNK_LENGTH`), para não sobrar pedaço magro. Cada chunk recebe uma linha `Fonte: <nome da nota>` para não perder contexto ao ser embeddado. |
| Embeddings (passo 3) | **Local via Ollama** | Grátis, privado e offline — os textos não saem da máquina (alinhado a "dono dos seus dados"). Alternativas descartadas: OpenAI (API paga, dados saem da máquina) e Transformers.js (puro npm, porém mais lento). A Anthropic não oferece API de embeddings. |
| Modelo de embedding | **`bge-m3`** (1024 dim.) — substituiu o `nomic-embed-text` | O `nomic-embed-text` é treinado essencialmente em inglês e falhou com notas em português: a resposta certa para "qual tecnologia para montar as telas?" ficou em **13º de 15**, e uma pergunta sobre bolo de cenoura pontuava 0,62. Com `bge-m3` (multilíngue), a mesma pergunta acerta em 1º e o controle cai para 0,26. Testadas e descartadas antes da troca: prefixos de tarefa e remoção do carimbo `Fonte:`. |
| Índice (passo 4) | **Arquivo JSON + varredura linear** | Zero dependências, dados inspecionáveis a olho nu, e a similaridade de cosseno escrita à mão — o conceito central a aprender. Descartados: SQLite vetorial (esconde a matemática) e Postgres (banco para 12 chunks). Isolado atrás de `src/store.ts`, então trocar depois custa reescrever um arquivo. |
| Interface (Fase 2) | **Aplicativo local**, começando por servidor local + navegador | Um app instalado é um processo de longa duração: carrega o índice uma vez e mantém na memória, então cada pergunta custa milissegundos — **isso elimina a necessidade de Postgres**. Também fecha a coerência do projeto (notas, embeddings, índice e interface, tudo local). Descartados por ora: Electron (peso), Tauri (exigiria Rust) e TUI (UI não reaproveitável). **Rebaixado a opcional** pela decisão do servidor MCP abaixo. |
| **Passo 5 — quem redige a resposta** | **O próprio Claude Code**, via um **servidor MCP** que expõe a busca como ferramenta | Elimina a decisão "Claude API vs. modelo local": o LLM passa a ser o Claude Code que o Heitor já usa no terminal, sem chave de API e sem custo extra. Registrado em escopo de usuário, o vault fica consultável **de dentro de qualquer projeto** — que é literalmente a ideia de segundo cérebro. Também torna a Fase 2 opcional: a ferramenta já fica usável sem app nenhum. Custo assumido: a redação final exige internet e os trechos recuperados saem da máquina (o que já ocorre ao usar o Claude Code neste repo). A busca e os embeddings seguem 100% locais. |
| Organização das notas | **Um vault por projeto** (`notes/<vault>/`), com índice separado por vault | Perguntar "por que escolhemos Postgres?" com tudo junto traz trechos de projetos diferentes que decidiram o mesmo por razões diferentes — é problema de **corretude**, não só de performance. Índices separados também evitam carregar tudo para responder sobre um projeto só. A busca aceita um vault específico ou cruza todos, conforme a pergunta. |

---

## O pipeline RAG (mapa dos 5 passos)

RAG = _Retrieval-Augmented Generation_. Em vez de jogar todas as notas no prompt
(estoura contexto, custa caro, afoga o modelo), primeiro **recupera-se** só os
trechos relevantes e só então **gera-se** a resposta com base neles.

1. **Ingerir** — ler os arquivos de nota da pasta. _(feito)_
2. **Fatiar (chunk)** — quebrar cada nota em pedaços menores, para recuperar o
   parágrafo relevante em vez da nota inteira (e porque embeddings funcionam
   melhor em trechos focados). _(feito — por seção)_
3. **Embeddar** — transformar cada pedaço num vetor (lista de números) de forma
   que textos com **significado parecido** fiquem **próximos** nesse espaço.
   É isso que faz "qual banco escolhemos?" encontrar "decidimos usar Postgres".
   _(feito — via Ollama com `bge-m3`)_
4. **Indexar** — guardar os vetores num índice de busca vetorial.
   _(feito — JSON por vault, com busca híbrida cosseno + BM25)_
5. **Consultar** — embeddar a pergunta, achar os pedaços mais próximos, entregar
   esses pedaços + a pergunta ao Claude e receber a resposta **citando a fonte**.
   _(feito — via servidor MCP; o Claude Code é quem redige)_

> **Os cinco passos estão concluídos.** As decisões de cada um, com as alternativas
> descartadas, estão na tabela acima.

---

## Escopo do MVP

**Dentro:** uma pasta → um índice → uma pergunta em português → uma resposta com
citação da nota de origem.

**Fora do MVP original, mas já entregues depois dele:** atualização automática do
índice, separação por projeto (vaults) e geração de notas por conversa (`save_note`).

**Ainda fora:** múltiplas fontes (GitHub, chats), ingestão de fontes extensas e
interface própria — ver o catálogo em `docs/arquitetura.md`, seção 9.

---

## Backlog / ideias para depois

Ideias registradas para não se perderem; ainda **não** fazem parte do MVP.

> ℹ️ **O backlog vivo mudou de casa.** O catálogo completo, agrupado por problema e
> com esforço estimado, está em `docs/arquitetura.md`, seção 9. Abaixo fica só o
> registro histórico das ideias originais e o que aconteceu com cada uma.

- ✅ **Gerador de notas a partir de ideias soltas** — virou a ferramenta `save_note`,
  sem precisar de app: a nota nasce da conversa com o Claude Code.
- ⬜ **Ingestão de fontes extensas → várias notas.** Continua no catálogo.
- ✅ **Atualização automática conforme o projeto evolui** — o servidor MCP reindexa
  sozinho ao detectar mudança nas notas.
- ⬜ **Novas fontes:** GitHub, conversas com LLMs, chats de equipe.
- ⬜ **Interface própria** — rebaixada a opcional; o Claude Code virou a interface.
- ✅ **Separação por projeto** — vaults, com índice e pasta de escrita próprios.

---

## Estado atual / onde retomar

_Atualizado em 2026-08-11._

- **Ambiente:** Node/TS pronto (`tsx`, `tsconfig.json`, `@types/node`); ESM
  (`"type": "module"`). Rodar o pipeline atual com `npm run ingest`.
- **Passo 1 (ingestão) — concluído:** `src/ingest.ts` lista e lê os `.md` de `notes/`.
- **Passo 2 (chunking) — concluído:** função `chunkByHeading` fatia por seção `##`;
  `mergeSmallChunks` funde os pequenos (`MIN_CHUNK_LENGTH = 120`); cada chunk é
  carimbado com `Fonte: <nome da nota>`. Total atual: **15 chunks** em 4 notas.
- **Passo 3 (embeddings) — CONCLUÍDO:** `src/embed.ts` chama o Ollama com `bge-m3`.
  O **texto é guardado junto do vetor** porque o embedding não é reversível — sem
  ele, a busca acha o chunk certo e não sabe o que ele diz.
- **Passo 4 (indexar) — CONCLUÍDO:** `src/store.ts` salva em `data/index.json`
  (fora do git — é derivado), implementa `cosineSimilarity` à mão e `search` por
  varredura linear.
- **Passo 5 (consultar) — EM ANDAMENTO. PARAMOS AQUI 👇**
  - ✅ `npm run ask -- [--vault <nome>] "pergunta"` embedda a pergunta e mostra os
    trechos mais próximos. Validado com perguntas sem nenhuma palavra em comum com
    as notas — ex.: *"como vamos deixar o app bonito?"* encontra a seção sobre Tailwind.
  - ✅ **Servidor MCP escrito** (`src/mcp-server.ts`, registrado em `.mcp.json`),
    expondo `list_vaults` e `search_notes(query, vault?, limit?)`. Testado na mão via
    JSON-RPC: handshake, listagem de ferramentas e chamada de busca funcionando.
  - ✅ **Validado em uso real em 2026-08-11:** pergunta em linguagem natural → o Claude
    Code chama `search_notes` → resposta redigida citando a nota de origem.

## 🎯 MVP CONCLUÍDO — 2026-08-11

O objetivo declarado no topo deste documento foi atingido: _"apontar a ferramenta para
uma pasta de notas em markdown, construir um índice semântico e permitir perguntas em
linguagem natural, com respostas que citam a nota de origem."_

Os 5 passos do pipeline estão fechados, mais duas coisas que não estavam no escopo
original e se mostraram necessárias: indexação incremental e separação por vault.

O trabalho daqui em diante é **expansão**, não MVP. Ver `docs/arquitetura.md`.

### Depois do MVP — concluído até aqui

- **Escopo de usuário:** servidor MCP registrado globalmente; o vault é consultável de
  dentro de qualquer projeto. Caminhos ancorados no arquivo, não no diretório de trabalho.
- **Registro de vaults (`vaults.json`):** as notas não precisam morar neste repositório —
  um vault aponta para pastas de outros projetos, que continuam versionadas com o código.
  Vários fontes por vault permitem juntar documentação oficial e anotações privadas.
- **Embedding paralelo:** pool de concorrência 4 (ponto ótimo medido). Ganho de 1,5×,
  não os 4× esperados — embeddar é limitado por CPU, não por espera de rede.
- **Teto de tamanho de chunk** e resiliência a falhas na indexação.
- **Verificação de tipos consertada** (`"types": []` no tsconfig ignorava o `@types/node`).

- **Índice em memória + reindexação automática:** o servidor MCP guarda os índices
  carregados entre chamadas e, antes de cada busca, compara contagem de arquivos e data
  de modificação. Se algo mudou, reindexa só aquilo. Busca repetida caiu de **155ms para
  4ms**; editar uma nota e perguntar em seguida funciona sem comando manual (0,5s).
  A varredura de cosseno sobre 1.543 chunks custa **4ms** — o gargalo sempre foi ler o
  JSON, nunca a matemática.

- **`save_note` via MCP:** captura conversando — _"anota que decidimos X porque Y"_ vira
  um `.md` estruturado no vault, indexado na hora e buscável em seguida. O vault declara
  `writeTo`; sem isso a escrita é recusada, para uma anotação pessoal nunca cair no
  repositório de trabalho de um cliente. O título vira nome de arquivo com sanitização
  contra *path traversal* (testado com `../../.ssh/authorized_keys` e afins).

### Próximo

👉 **O painel de status vive em `docs/arquitetura.md`, seção 0** — fase atual,
procedimento a executar agora, estado por frente e o que deliberadamente não fazer.

Resumo em uma linha: Fase 1 concluída; o próximo passo é **ampliar a suíte de
avaliação**, porque ela hoje detecta regressão mas não mede ganho.
