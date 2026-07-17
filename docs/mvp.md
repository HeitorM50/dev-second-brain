# MVP — dev-second-brain

Documento vivo com as decisões e o escopo da primeira versão. Atualize conforme o projeto evolui.

_Última atualização: 2026-07-15_

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

---

## O pipeline RAG (mapa dos 5 passos)

RAG = _Retrieval-Augmented Generation_. Em vez de jogar todas as notas no prompt
(estoura contexto, custa caro, afoga o modelo), primeiro **recupera-se** só os
trechos relevantes e só então **gera-se** a resposta com base neles.

1. **Ingerir** — ler os arquivos de nota da pasta.
2. **Fatiar (chunk)** — quebrar cada nota em pedaços menores, para recuperar o
   parágrafo relevante em vez da nota inteira (e porque embeddings funcionam
   melhor em trechos focados).
3. **Embeddar** — transformar cada pedaço num vetor (lista de números) de forma
   que textos com **significado parecido** fiquem **próximos** nesse espaço.
   É isso que faz "qual banco escolhemos?" encontrar "decidimos usar Postgres".
4. **Indexar** — guardar os vetores num índice de busca vetorial.
5. **Consultar** — embeddar a pergunta, achar os pedaços mais próximos, entregar
   esses pedaços + a pergunta ao Claude e receber a resposta **citando a fonte**.

> Decisões dos passos 3, 4 e 5 (provider de embeddings, índice vetorial local
> vs. pgvector, LLM para a resposta) serão tomadas quando chegarmos a cada passo,
> com o trade-off na mesa — não antes.

---

## Escopo do MVP

**Dentro:** uma pasta → um índice → uma pergunta em português → uma resposta com
citação da nota de origem.

**Fora por enquanto:** atualização automática, múltiplas fontes, GitHub, chats,
geração de notas, interface Next.js, separação por projeto.

---

## Backlog / ideias para depois

Ideias registradas para não se perderem; ainda **não** fazem parte do MVP.

- **Gerador de notas a partir de ideias soltas.** Eu dou uma ideia crua para uma
  IA, ela estrutura melhor e já gera o `.md` bem-formatado na pasta de notas.
  _(Observação: isso é a "outra metade" do sistema — a parte de ingestão que
  **cria** markdown. O MVP cobre a metade que **consulta** o markdown existente.)_
- **Ingestão de fontes extensas → várias notas.** Dado um projeto com documentação
  grande e várias fontes de informação, trazer esse material da forma mais prática
  possível para o gerador ler e produzir várias notas alimentando a pasta.
- Atualização automática e contínua conforme o projeto evolui.
- Novas fontes: GitHub (PRs, issues, commits), conversas com LLMs, chats de equipe.
- Interface web em Next.js sobre o núcleo do RAG.
- Separação e isolamento por projeto (um "vault" por projeto).
