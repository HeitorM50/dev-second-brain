# dev-second-brain

**AI Second Brain for Developers** — um segundo cérebro que preserva o contexto de projetos e responde, em linguagem natural, perguntas sobre decisões passadas.

Você conversa com o Claude Code normalmente. Quando a pergunta é sobre algo que já foi decidido, ele consulta suas notas e responde citando de onde tirou. Quando você decide algo novo, ele oferece anotar — e, ao fim do trabalho, revisa a conversa atrás do que ficou para trás.

> _"o que a gente decidiu sobre o banco no TaskFlow e por quê?"_
> _"anota aí que vamos usar sessão própria em vez de Auth0, por causa do custo por usuário"_
> _"é isso por hoje"_ → ele levanta as decisões da conversa e pergunta o que guardar

Busca e embeddings rodam **inteiramente na sua máquina**. Não há chave de API, mensalidade nem serviço externo na indexação.

---

**Sumário**

- [Parte 1 — Como funciona por dentro](#parte-1--como-funciona-por-dentro) (técnico)
- [Parte 2 — Como usar no dia a dia](#parte-2--como-usar-no-dia-a-dia) (sem jargão)

---

# Parte 1 — Como funciona por dentro

## Visão geral

```
   suas notas .md          ⚙️ INDEXAÇÃO (esporádica)              🧭 índice
┌────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────┐
│ notes/<vault>/     │   │ 1. varrer .md recursivamente │   │ data/vaults/     │
│ ~/Projects/x/docs/ │ → │ 2. fatiar por seção          │ → │   <vault>.json   │
│ qualquer pasta     │   │ 3. embeddar (Ollama, local)  │   │ texto + vetor    │
└────────────────────┘   │ 4. gravar                    │   └──────────────────┘
                         └──────────────────────────────┘            │
                                                                     ▼
   você, no terminal        💬 CONSULTA (a cada pergunta)     ┌──────────────────┐
┌────────────────────┐   ┌──────────────────────────────┐    │ similaridade de  │
│ "o que decidimos   │ → │ Claude Code → servidor MCP   │ ←  │ cosseno sobre    │
│  sobre o banco?"   │   │ → embedda a pergunta         │    │ todos os chunks  │
└────────────────────┘   │ → devolve os 5 mais próximos │    └──────────────────┘
         ▲               │ → Claude redige com citação  │
         └───────────────┴──────────────────────────────┘
```

Dois momentos distintos, e isso é o que torna o RAG viável: embeddar é lento (~1,1s por trecho), buscar é rápido (4ms). O trabalho pesado acontece **antes**, uma vez, e é reaproveitado.

## Stack

| Camada | Tecnologia | Por quê |
|---|---|---|
| Núcleo | TypeScript / Node (ESM, `tsx`) | Reaproveitável por qualquer interface futura |
| Embeddings | Ollama + `bge-m3` (1024 dim.) | Local, grátis, multilíngue — modelos só de inglês falham com notas em português |
| Índice | JSON por vault + varredura linear | Zero dependências, dados inspecionáveis; isolado atrás de `src/store.ts` |
| Interface / redação | Claude Code via **MCP** | Sem chave de API, disponível de qualquer pasta |

Dependências de produção: `@modelcontextprotocol/sdk` e `zod`. Só isso.

## Módulos

| Arquivo | Responsabilidade |
|---|---|
| `src/vaults.ts` | Lê `vaults.json`; resolve as pastas de cada vault e varre `.md` recursivamente |
| `src/indexer.ts` | Fatia, embedda e grava. **Módulo chamável** — usado pelo CLI e pelo servidor MCP, para que reindexar à mão e automaticamente rodem o mesmo código |
| `src/embed.ts` | Texto → vetor, via `POST localhost:11434/api/embeddings` |
| `src/concurrency.ts` | Pool de trabalhadores com limite de chamadas simultâneas |
| `src/lexical.ts` | Busca lexical (BM25 + fusão RRF) — implementada, hoje desligada por medição |
| `src/store.ts` | **Fronteira de armazenamento**: gravar, carregar, hash, caches, similaridade e busca |
| `src/frontmatter.ts` | Metadados das notas: data, status e decisões substituídas |
| `src/notes.ts` | Criação de notas a partir de conversa: slug seguro e escrita restrita ao vault |
| `src/mcp-server.ts` | Servidor MCP: expõe as cinco ferramentas ao Claude Code e gera o bloco de captura instalado nos projetos |
| `src/ingest.ts` | CLI de indexação (casca fina sobre `indexer.ts`) |
| `src/ask.ts` | CLI de busca, para depuração |
| `src/eval.ts` | Avaliação da qualidade da busca |

`store.ts` concentra tudo que sabe onde os dados moram. Migrar para SQLite ou Postgres um dia significa reescrever esse arquivo e mais nada.

## O pipeline de indexação, passo a passo

**1. Varredura.** Cada vault declara pastas em `vaults.json`. A varredura é recursiva e ignora sempre `.git`, `node_modules`, `dist`, `build`, `.next`, `data` e pastas ocultas — além do que estiver em `exclude`.

**2. Fatiamento.** Em três etapas, nesta ordem:

| Etapa | Regra | Por quê |
|---|---|---|
| Cortar | nova seção a cada linha iniciada por `#` | uma seção é uma unidade de sentido |
| Fundir | trechos com menos de **120** caracteres entram no vizinho | título solto vira chunk inútil |
| Dividir | trechos com mais de **2.000** caracteres quebram em parágrafos, repetindo o título em cada pedaço | seções gigantes estouram a janela do modelo, e um vetor para 20 páginas vira uma média sem foco |

Cada trecho recebe uma primeira linha `Fonte: <caminho>` antes de ser embeddado.

**3. Embedding.** Cada trecho vira 1024 números via Ollama. Concorrência de **4** chamadas simultâneas (ajustável com `EMBED_CONCURRENCY`). Medido nesta máquina: 4 é o ponto ótimo, com ganho de ~1,5× sobre sequencial — o ganho é modesto porque embeddar é limitado por CPU, não por espera de rede.

Um trecho que falhe é registrado e pulado; o resto do índice é salvo.

**4. Gravação.** `data/vaults/<vault>.json`, com esta forma:

```json
{
  "model": "bge-m3",
  "sources": { "fileCount": 93, "maxMtimeMs": 1754... },
  "chunks": [
    { "vault": "...", "source": "docs/decisao.md", "text": "...", "hash": "a3f5...", "embedding": [0.34, ...] }
  ]
}
```

O `model` gravado existe para invalidar o cache se o modelo mudar — vetores de modelos diferentes não são comparáveis, e sem essa checagem o índice ficaria silenciosamente corrompido. O `sources` serve para detectar edições sem reler arquivo.

A pasta `data/` está no `.gitignore`: o índice é derivado das notas e reconstruível.

## Indexação incremental

Cada trecho carrega um **SHA-256 do seu texto**. Ao reindexar, só o que não está no cache é embeddado de novo.

| Situação | Custo real medido |
|---|---|
| Primeira indexação de 1.543 trechos | 28 min |
| Reindexar sem mudanças | 0,6s |
| Reindexar após editar uma nota | 0,5s |

## Consulta

A busca é **por varredura linear**: compara a pergunta com todos os trechos por similaridade de cosseno, ordena e devolve os melhores. Sem índice aproximado, sem banco.

Existe também um ranking lexical (BM25) combinável por *Reciprocal Rank Fusion*, hoje **desligado** — a medição mostrou que ele piora a profundidade da recuperação. Detalhes e números adiante.

```
carregar o índice do disco (32 MB, 1.543 trechos) ...... 150ms
calcular o cosseno contra todos os trechos ................ 4ms
```

O gargalo nunca foi a matemática — era ler o JSON. Por isso o servidor MCP mantém os índices carregados em memória entre chamadas, invalidando pela data de modificação do arquivo. **A partir da segunda pergunta, a busca custa 4ms.**

## Frescor automático

Antes de cada busca, o servidor MCP compara a contagem de arquivos e a data de modificação mais recente com o que está gravado no índice. Se mudou, reindexa aquele vault (incrementalmente) antes de responder.

Consequência prática: **você edita uma nota no editor e pergunta em seguida — não precisa rodar comando nenhum.** O `npm run ask` do terminal **não** faz isso; ele lê o índice como está.

## Ferramentas MCP expostas

| Ferramenta | Assinatura | Comportamento |
|---|---|---|
| `list_vaults` | — | Nomes dos vaults indexados |
| `search_notes` | `query`, `vault?`, `limit?`, `since?`, `until?` | Verifica frescor, embedda a pergunta e devolve os trechos mais próximos, com semelhança, termos em comum e origem. Sem `vault`, cruza todos |
| `save_note` | `vault`, `title`, `content` | Cria `.md` na pasta `writeTo` do vault, com front-matter, e indexa na hora |
| `review_decisions` | `vault`, `decisions[]` | Recebe até 10 decisões candidatas de uma conversa, embedda em paralelo e devolve as **notas distintas** mais próximas de cada uma. Não julga duplicata — reporta para o Claude ler |
| `add_vault` | `name`, `sources[]`, `exclude?`, `projectRoot?` | Registra um projeto novo: cria `notes/<name>` como pasta privada, grava em `vaults.json` com caminho relativo e indexa na hora se forem até 30 arquivos. Com `projectRoot`, instala também a regra de captura no `CLAUDE.md` do projeto |

As descrições dessas ferramentas são parte do sistema, não documentação: é o texto delas que faz o Claude decidir quando acionar a busca e o que incluir numa nota. Mexer ali muda o comportamento.

O `review_decisions` desduplica **por arquivo**: pede à busca quatro vezes mais trechos do que vai mostrar e fica com o melhor de cada nota. Sem isso, uma nota longa ocuparia as duas vagas sozinha, e a resposta seria "as duas mais parecidas" apontando para o mesmo arquivo.

## Captura de fim de sessão

O `save_note` resolve *como* registrar, mas não *quando*. Na prática a decisão é tomada no meio do trabalho, o registro fica para depois, e depois nunca chega — o vault `grupo03` tinha 1.543 trechos indexados e **zero** notas criadas por conversa.

A solução é uma instrução no `CLAUDE.md` do projeto, não código. O `add_vault` a instala quando recebe `projectRoot`:

| Situação | Comportamento |
|---|---|
| `CLAUDE.md` não existe | cria com o bloco |
| já existe | **acrescenta ao fim** — nunca sobrescreve |
| já contém o bloco | não duplica; reporta que já estava lá |
| vault já registrado | não recadastra, só instala a regra |

`projectRoot` é opcional **de propósito**: isto escreve dentro do repositório de outro projeto, que pode ser de trabalho ou de um grupo. A descrição da ferramenta instrui o Claude a perguntar antes de preenchê-lo, e a presença do parâmetro é o consentimento. Sem ele, o bloco é apenas impresso como sugestão.

O ritual que o bloco instala: revisar a conversa → `review_decisions` para ver o que já existe → **uma chamada de `save_note` por decisão**, nunca uma nota-diário. Um trecho que mistura assuntos gera um vetor no meio do caminho entre eles e não casa forte com pergunta nenhuma.

O gatilho são os dois momentos que o Claude consegue observar: um sinal explícito ("é isso por hoje") e o instante antes de um commit. Um hook do `Stop`/`SessionEnd` observaria o encerramento de verdade, mas mora fora do projeto e fica intrusivo se mal calibrado — ficou adiado, não descartado.

⚠️ **Esta é a única funcionalidade que `npm run eval` não mede.** A suíte avalia busca, não captura.

## Segurança da escrita

`save_note` só escreve na pasta declarada em `writeTo` e **recusa** se ela não existir na configuração — sem isso, uma anotação pessoal poderia acabar dentro do repositório de trabalho de um cliente.

O título vem do modelo e vira nome de arquivo, então é sanitizado: `NFD` + remoção de acentos, tudo que não é `[a-z0-9]` vira hífen, limite de 60 caracteres. Depois há uma segunda checagem confirmando que o caminho final está mesmo dentro da pasta do vault.

| Título | Arquivo gerado |
|---|---|
| `../../.ssh/authorized_keys` | `ssh-authorized-keys.md` |
| `/etc/passwd` | `etc-passwd.md` |
| `!!!???` | `nota.md` |

A instalação da regra de captura é a **única** escrita fora deste repositório. Ela é opt-in via `projectRoot`, nunca sobrescreve arquivo existente e reconhece o próprio bloco pelo título para não empilhar cópias.

## Qualidade da busca — medida, não estimada

`npm run eval` roda `eval/questions.json`: **39 perguntas** com nota correta esperada e **6 controles negativos**, cobrindo os três vaults — inclusive um com 1.543 trechos.

Baseline em 2026-08-14:

| Métrica | Valor | Leitura |
|---|---|---|
| Recall@1 | 69% | nota certa em primeiro |
| Recall@3 | 92% | |
| Recall@5 | **97%** | o trecho certo chega ao contexto do LLM |
| MRR | 0,799 | |
| Decisões revistas | 1/1 | notas superadas saem sinalizadas |
| Separação | −0,021 | ⚠️ ver abaixo |

A suíte cobre paráfrase sem palavra em comum, termo exato (identificadores e siglas), resposta em nota citada por link, busca cruzada sem vault declarado e controles negativos.

**A única falha de Recall@5** é uma pergunta de **contagem** ("quantas personas o projeto definiu?"). RAG é estruturalmente fraco em agregar — recupera trechos, não soma fatos. Limite conhecido, não bug.

### Por que a busca lexical está desligada

BM25 e fusão RRF estão implementados, mas desativados por padrão (`LEXICAL_WEIGHT=0`), porque a medição não sustentou a hipótese:

| Peso lexical (acervo de 2026-08-13) | Recall@1 | Recall@5 | MRR |
|---|---|---|---|
| **0** | 72% | **97%** | 0,819 |
| 0,3 | **75%** | 94% | 0,826 |
| 1,0 | 75% | 92% | 0,813 |

O BM25 melhora o topo e piora a profundidade — e **Recall@5 é o que manda**: se o trecho certo não entra nos 5 que vão ao contexto, o LLM não responde; sair em 1º ou 2º quase não muda nada.

Além disso, as perguntas por termo exato (`bge-m3`, `GOMS`, `MIN_CHUNK_LENGTH`) passaram todas com a semântica pura. Para religar e comparar: `LEXICAL_WEIGHT=0.3 npm run eval`.

### Limitação conhecida: a pontuação é ordinal

A similaridade **ordena resultados entre si; não mede relevância absoluta**. Não existe limiar universal, e o teto de falso positivo sobe com o tamanho do acervo:

| Escopo | Melhor falso positivo |
|---|---|
| vault pequeno (15 trechos) | 0,304 |
| vault grande (1.543) | 0,380 |
| todos os vaults (1.618) | **0,404** |

O pior acerto legítimo fica em 0,377 — ou seja, **nenhum corte numérico separa os dois grupos**, e a busca cruzada é o pior caso. Por isso quem julga relevância é o Claude, lendo o conteúdo: a descrição da ferramenta instrui a dizer "não encontrei registro" em vez de responder por coincidência de palavras, e a saída avisa quando nem o melhor resultado é forte.

Consequência direta no `review_decisions`: decisões **comprovadamente ausentes** do acervo ("adotar Kubernetes", "trocar para pnpm") pontuam ~0,52, acima do limiar de aviso. Não existe limiar de duplicata; a ferramenta mostra as notas vizinhas e o Claude lê.

### Limitação conhecida: o acervo compete consigo mesmo

Em 2026-08-14, gravar quatro notas legítimas derrubou o Recall@1 de 72% para 69% e o MRR de 0,816 para 0,797 — **sem uma linha da busca ter mudado**.

Medido tirando e recolocando as notas: **uma única pergunta se mexeu**, *"quem escreve a resposta final para o usuário?"*, do 1º para o 4º lugar. Os três trechos que passaram na frente vieram todos da nota nova, com **0% de palavras em comum** com a pergunta — o modelo entende "quem faz o quê entre o Claude e o Heitor" como o mesmo assunto de "quem escreve a resposta".

Isso é inerente a buscar por significado: quanto maior o acervo, mais vizinhos plausíveis cada pergunta tem. A defesa é o **Recall@5**, que segurou em 97%.

> **Como ler as métricas no futuro:** queda no Recall@1 depois de gravar notas é **esperada**, não regressão. Só investigue se o **Recall@5** cair.

⚠️ Pelo mesmo motivo, os números oscilam ±1 pergunta a cada edição de `docs/arquitetura.md`: o vault `dev-second-brain` indexa a pasta `docs/`, então escrever sobre as métricas muda o acervo medido. Este README fica na raiz e **não** é indexado.

## Front-matter: o que a busca semântica não deduz

Notas podem declarar metadados num bloco no topo. O `save_note` gera automaticamente; notas sem o bloco continuam funcionando.

```yaml
---
data: 2026-08-13
projeto: taskflow
tags: [banco, decisao]
status: ativo          # ou: superseded
superseded_by: nome-da-nota-nova
---
```

O bloco é **removido antes do embedding** — é metadado estruturado, não conteúdo.

**Filtro por data.** _"O que decidimos em julho?"_ é pergunta de data, não de significado: nenhum embedding responde isso de forma confiável. Os parâmetros `since` e `until` de `search_notes` recortam por `data` antes de ordenar. Notas **sem data declarada nunca são filtradas** — descartá-las faria um recorte de período esconder silenciosamente todo o acervo antigo.

**Decisões revistas.** Uma nota com `status: superseded` continua sendo recuperável — perguntas históricas ("por que escolhemos X na época?") têm resposta legítima nela — mas o resultado sai com alerta:

```
⚠️ DECISÃO REVISTA — esta nota foi substituída por "decisao-modelo-embedding".
Não a apresente como decisão vigente.
```

Sem isso, uma decisão revogada seria apresentada como se ainda valesse — a falha mais perigosa numa ferramenta de memória.

## Configuração de vaults

```json
{
  "vaults": {
    "meu-projeto": {
      "sources": ["/home/heitor/Projects/meu-projeto/docs", "notes/meu-projeto"],
      "exclude": ["CHANGELOG", "api-reference"],
      "writeTo": "notes/meu-projeto"
    }
  }
}
```

| Campo | Obrigatório | O que faz |
|---|---|---|
| `sources` | sim | Pastas que alimentam o vault. Relativas à raiz do projeto ou absolutas |
| `exclude` | não | Ignora qualquer caminho que contenha um destes trechos |
| `writeTo` | para usar `save_note` | Onde notas novas são criadas. Deve ser uma das `sources` |

## Comandos

```bash
npm run ingest      # reconstrói os índices de todos os vaults
npm run ask -- "pergunta"                    # busca em todos os vaults
npm run ask -- --vault taskflow "pergunta"   # busca em um só
npm run eval        # mede a qualidade da busca
npm run eval -- --verbose
npm run typecheck   # tsc --noEmit
```

## Instalação

```bash
sudo systemctl start ollama
ollama pull bge-m3
npm install
npm run ingest

claude mcp add -s user dev-second-brain -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/src/mcp-server.ts"
```

Confira com `claude mcp list` — deve aparecer `✔ Connected`. Reinicie o Claude Code para as ferramentas ficarem disponíveis.

Os caminhos internos são ancorados na localização dos arquivos (`import.meta.dirname`), não no diretório de trabalho — por isso o servidor funciona chamado de qualquer pasta.

---

# Parte 2 — Como usar no dia a dia

Sem jargão. Se a Parte 1 pareceu grega, comece por aqui.

## O que essa ferramenta é, em uma frase

**Um caderno que você consulta falando.**

Você anota decisões dos seus projetos. Depois, quando esquecer por que fez algo, pergunta em português e recebe a resposta com a indicação de qual anotação veio.

## Por que ela existe

Daqui a três meses você vai olhar um pedaço de código e pensar *"por que diabos eu fiz assim?"*. A resposta existia na sua cabeça no dia da decisão e evaporou. Essa ferramenta é o lugar onde ela não evapora.

## A grande sacada: ela entende o que você quis dizer

Um `Ctrl+F` procura a palavra exata. Se você anotou *"vamos usar Tailwind"* e depois pergunta *"como a gente ia deixar o app bonito?"*, o Ctrl+F não acha nada — não há palavra em comum.

Essa ferramenta acha. Ela compara **significado**, não letras. Você não precisa lembrar como escreveu; basta perguntar do jeito que a dúvida veio à cabeça.

## Os três verbos que você precisa saber

Tudo se resume a isto:

### 1️⃣ ANOTAR — quando decidir algo

Você está trabalhando, toma uma decisão, e fala:

> **"anota que vamos usar Postgres em vez de Mongo, porque nossos dados são todos relacionais"**

Pronto. Vira um arquivo organizado, com data, o que foi decidido e o motivo. Você não escolhe nome de arquivo, não abre editor, não formata nada.

💡 **O mais importante:** sempre diga o **porquê**. "Usamos Postgres" não te ajuda em nada daqui a seis meses. "Usamos Postgres porque os dados são relacionais e descartamos Mongo por isso" te salva.

### 2️⃣ PERGUNTAR — quando esquecer algo

> **"o que a gente decidiu sobre autenticação no TaskFlow?"**
> **"por que não fomos de MongoDB mesmo?"**
> **"em quais projetos eu já usei Postgres?"**

A resposta vem junto com o nome da anotação de onde saiu, para você poder conferir.

E funciona **de qualquer pasta do computador**. Você pode estar mexendo em outro projeto e perguntar sobre este — não precisa vir até aqui.

### 3️⃣ EDITAR — quando quiser corrigir

As anotações são arquivos `.md` comuns. Abra no editor que quiser, mude o que quiser, salve. A ferramenta percebe sozinha na próxima pergunta.

**Não existe passo 4.** Não tem botão de sincronizar, não tem "atualizar índice", não tem nada para lembrar.

## E se você esquecer de anotar?

Esse era o furo da ferramenta, e é o que mudou agora.

Anotar custava uma frase — mas ainda custava **lembrar**. Na vida real a decisão é tomada no meio do trabalho, você pensa "depois eu anoto", e depois não chega nunca.

Agora, quando você fala que está encerrando — *"é isso por hoje"*, *"pode parar"*, *"vamos commitar"* — o Claude faz sozinho:

1. Relê a conversa e separa as decisões que você tomou.
2. Confere quais delas **você já anotou antes**, para não criar nota repetida.
3. Te mostra só o que sobrou e pergunta o que quer guardar.
4. Grava **uma anotação para cada decisão**, com o motivo e o que foi descartado.

Você só responde "essas duas" e segue a vida.

Três coisas que ele **não** faz, de propósito:

- Não anota mudança boba: renomear variável, corrigir typo, ajustar formatação.
- Não inventa. Se a conversa não teve decisão nenhuma, ele diz isso e para.
- Não junta tudo numa anotação só de "resumo do dia" — cada decisão vira um arquivo, senão a busca piora para todas.

> Para isso funcionar num projeto, ele precisa estar ligado ali. É um pedido só: **"instala a regra de registro aqui"**. Detalhe no cenário 📝 abaixo.

## Onde ficam suas anotações

Em pastas normais do seu computador, como arquivos de texto que qualquer editor abre. **Nada fica preso na ferramenta.**

Cada projeto tem sua própria gaveta, chamada de **vault**. Isso não é frescura organizacional — se tudo ficasse junto, perguntar *"por que escolhemos Postgres?"* traria a resposta de três projetos misturados, um deles tendo decidido o contrário. A resposta viria confusa ou errada.

## Passo a passo, por cenário

Ache o seu caso e siga a receita.

---

### 🅰️ Projeto que JÁ TEM documentação escrita

_Exemplo: um projeto com pasta `docs/`, ADRs, atas de reunião._

**Objetivo:** tornar o que já existe consultável, sem mexer em nada.

1. Abra o Claude Code **dentro do projeto**.
2. Diga: **"adiciona esse projeto ao meu segundo cérebro, a documentação está em `docs/`"**
3. Se ele avisar que são muitos arquivos, vá até o `dev-second-brain` e rode `npm run ingest`. Pode ir tomar um café — projeto grande leva minutos, e é só a primeira vez.
4. Pronto. Já pode perguntar: **"o que já foi decidido sobre autenticação aqui?"**

**Importante:** aponte para a pasta de documentação, não para a raiz do projeto. A raiz traz README de biblioteca e arquivos gerados, que sujam a busca.

**A partir daí:** você continua editando a documentação como sempre, no lugar de sempre. A ferramenta acompanha sozinha.

---

### 🅱️ Projeto que NÃO TEM documentação nenhuma

_Exemplo: um projeto antigo que só existe como código._

**Objetivo:** começar a acumular memória a partir de hoje, sem precisar parar para escrever documentação.

1. Abra o Claude Code dentro do projeto.
2. Diga: **"adiciona esse projeto ao meu segundo cérebro"** — sem pasta de documentação, ele cria só a gaveta de anotações.
3. Trabalhe normalmente. Quando decidir algo, diga: **"anota que decidi X porque Y"**
4. Depois de algumas semanas, você terá um histórico que nunca precisou "sentar para escrever".

**Não tente documentar o passado de uma vez.** Anote o que for surgindo. Vinte notas boas acumuladas valem mais que uma tentativa de documentar tudo que morre no terceiro dia.

---

### 🆕 Projeto começando do zero

_Exemplo: você acabou de rodar `git init`._

**Objetivo:** capturar as decisões de fundação, que são as mais caras de esquecer.

1. Crie o projeto normalmente.
2. Adicione ao segundo cérebro logo no começo: **"adiciona esse projeto"**
3. **Anote as decisões de base assim que tomá-las** — linguagem, banco, framework, estrutura de pastas. São justamente as que ninguém documenta e as que mais doem quando esquecidas.
4. Peça **"instala a regra de registro aqui"** (próximo cenário) para não depender de lembrar.

> As decisões de fundação são as que mais se esquece e as mais caras de reconstruir. Anotar "escolhi X em vez de Y por causa de Z" custa dez segundos no dia e economiza uma tarde daqui a um ano.

---

### 📝 Projeto que você quer ir documentando conforme trabalha

**Objetivo:** parar de precisar lembrar de anotar.

1. Adicione o projeto (cenários acima).
2. Diga: **"instala a regra de registro aqui"**.
3. É só isso.

Ele vai **pedir sua autorização antes**, porque isso escreve um arquivo dentro do repositório daquele projeto. Depois que você autorizar, ele mesmo grava — você não precisa copiar e colar nada.

A partir daí, dentro daquele projeto, o Claude passa a:

- **oferecer registro na hora** em que uma decisão é tomada;
- **fazer a revisão de fim de sessão** quando você disser que está parando, ou antes de um commit;
- **consultar o que já foi decidido** antes de sugerir mudança estrutural — o que evita ele propor algo que você já descartou por um bom motivo.

**Já vale para projeto antigo.** Se você adicionou um projeto antes disso existir, é o mesmo pedido — ele não recadastra nada, só liga a regra.

Se preferir fazer à mão, peça o bloco sem autorizar a escrita: ele te mostra o texto para você colar no `CLAUDE.md` da raiz do projeto. Esse arquivo é lido automaticamente toda vez que o Claude Code abre ali.

---

### 🔀 Projeto de trabalho, com anotação que NÃO pode ir para o repositório

_Exemplo: código de cliente, e você quer anotar "essa arquitetura tem um problema sério" sem que vire commit._

**Isso já é o comportamento padrão** — não precisa fazer nada de especial.

Ao adicionar um projeto, duas coisas separadas são configuradas:

| | Onde fica | O que acontece |
|---|---|---|
| Documentação do projeto | no repositório dele | **só é lida**, nunca escrita |
| Suas anotações | em `notes/<projeto>/`, aqui | é onde tudo que você anota vai parar |

As duas são consultadas juntas nas buscas. Suas anotações particulares nunca tocam o repositório do cliente.

---

### 🔎 Consultar sem lembrar de qual projeto era

Simplesmente **não diga o projeto**:

> **"em quais projetos eu já usei Postgres?"**
> **"onde eu já resolvi upload de arquivo grande?"**

A busca cruza todos os vaults e cada resposta diz de qual projeto veio. Útil para reaproveitar solução, e para lembrar que você já resolveu esse problema antes.

---

### 🗑️ Parar de acompanhar um projeto

Abra `vaults.json`, apague a entrada dele e salve. Se quiser limpar o índice, apague também `data/vaults/<nome>.json`.

Suas anotações em `notes/<nome>/` **continuam lá** — apagar o vault não apaga nota nenhuma.

---

## Usando com o Obsidian

As pastas de `notes/` são vaults do Obsidian — é só abrir, sem converter nada. Os arquivos usam `[[links entre notas]]`, então o **grafo já aparece montado**.

Combina bem: você edita no Obsidian, salva, e a próxima pergunta já considera a mudança. Obsidian vira o editor confortável; o Claude Code vira a busca.

Uma ressalva: abrir a pasta `notes/` inteira mostra todos os projetos num grafo só. Abrir só `notes/<projeto>/` isola um projeto, mas perde a visão geral. Escolha conforme o que quiser enxergar.

> Os links servem para **você navegar**, não para a busca — ela compara significado, e um `[[link]]` é só texto para ela. Fazer a busca seguir os links chegou a ser construído e medido: não trouxe ganho nenhum neste tamanho de acervo, e ficou desligado.

## Uma rotina que funciona

- **Ligue a regra de registro** em todo projeto que você adicionar. É o passo que faz o resto acontecer sem você.
- **Ao parar de trabalhar**, diga: "é isso por hoje". Ele revisa e pergunta o que guardar.
- **Vai começar uma tarefa numa parte do código que não toca há tempo?** "o que eu já decidi sobre essa parte?"
- **Alguém te pergunta por que o sistema é assim?** Pergunte antes de responder de memória.
- **No meio do trabalho**, quando a decisão for grande demais para esperar o fim da sessão: "anota aí o que decidimos e por quê"

## Duas coisas honestas

**1. Se nada for anotado, ela não serve para nada.** Não existe mágica: a ferramenta responde a partir do que foi escrito. A revisão de fim de sessão reduz muito o esforço, mas não elimina você da conta — é você quem confirma o que vale guardar, e é você quem precisa ligar a regra em cada projeto.

**2. Ela pode trazer coisa que não responde sua pergunta.** A busca sempre devolve os trechos "mais parecidos", mesmo quando nenhum serve. O Claude foi instruído a perceber isso e dizer que não encontrou, mas confira a anotação citada quando a resposta parecer estranha. **É um caderno, não um oráculo.**

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| "não consegui gerar o vetor da pergunta" | O Ollama está desligado: `sudo systemctl start ollama` |
| Ele não acha uma nota que você sabe que existe | A pasta dela está declarada em `vaults.json`? Rode `npm run ingest` |
| Respostas parecem desatualizadas | `npm run ingest` sincroniza tudo de uma vez. Para reconstruir do zero, apague `data/` antes |
| Quer ver a busca crua, sem o Claude no meio | `npm run ask -- "sua pergunta"` |

---

Desenvolvido por [@HeitorM50](https://github.com/HeitorM50).
