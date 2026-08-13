# dev-second-brain

**AI Second Brain for Developers** — um segundo cérebro que preserva o contexto de projetos e responde, em linguagem natural, perguntas sobre decisões passadas.

Você conversa com o Claude Code normalmente. Quando a pergunta é sobre algo que já foi decidido, ele consulta suas notas e responde citando de onde tirou. Quando você decide algo novo, pede para ele anotar.

> _"o que a gente decidiu sobre o banco no TaskFlow e por quê?"_
> _"anota aí que vamos usar sessão própria em vez de Auth0, por causa do custo por usuário"_

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
| `src/store.ts` | **Fronteira de armazenamento**: gravar, carregar, hash, cache, similaridade de cosseno, busca |
| `src/notes.ts` | Criação de notas a partir de conversa: slug seguro e escrita restrita ao vault |
| `src/mcp-server.ts` | Servidor MCP: expõe as três ferramentas ao Claude Code |
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

A busca é **varredura linear**: compara a pergunta com todos os trechos, ordena e devolve os melhores. Sem índice aproximado, sem banco.

```
carregar o índice do disco (32 MB, 1.543 trechos) ...... 150ms
calcular cosseno contra todos os trechos ................. 4ms
```

O gargalo nunca foi a matemática — era ler o JSON. Por isso o servidor MCP mantém os índices carregados em memória entre chamadas, invalidando pela data de modificação do arquivo. **A partir da segunda pergunta, a busca custa 4ms.**

## Frescor automático

Antes de cada busca, o servidor MCP compara a contagem de arquivos e a data de modificação mais recente com o que está gravado no índice. Se mudou, reindexa aquele vault (incrementalmente) antes de responder.

Consequência prática: **você edita uma nota no editor e pergunta em seguida — não precisa rodar comando nenhum.** O `npm run ask` do terminal **não** faz isso; ele lê o índice como está.

## Ferramentas MCP expostas

| Ferramenta | Assinatura | Comportamento |
|---|---|---|
| `list_vaults` | — | Nomes dos vaults indexados |
| `search_notes` | `query`, `vault?`, `limit?` (padrão 5) | Verifica frescor, embedda a pergunta, devolve os trechos mais próximos com pontuação e origem. Sem `vault`, cruza todos |
| `save_note` | `vault`, `title`, `content` | Cria `.md` na pasta `writeTo` do vault e indexa na hora |

As descrições dessas ferramentas são parte do sistema, não documentação: é o texto delas que faz o Claude decidir quando acionar a busca e o que incluir numa nota. Mexer ali muda o comportamento.

## Segurança da escrita

`save_note` só escreve na pasta declarada em `writeTo` e **recusa** se ela não existir na configuração — sem isso, uma anotação pessoal poderia acabar dentro do repositório de trabalho de um cliente.

O título vem do modelo e vira nome de arquivo, então é sanitizado: `NFD` + remoção de acentos, tudo que não é `[a-z0-9]` vira hífen, limite de 60 caracteres. Depois há uma segunda checagem confirmando que o caminho final está mesmo dentro da pasta do vault.

| Título | Arquivo gerado |
|---|---|
| `../../.ssh/authorized_keys` | `ssh-authorized-keys.md` |
| `/etc/passwd` | `etc-passwd.md` |
| `!!!???` | `nota.md` |

## Qualidade da busca — medida, não estimada

`npm run eval` roda `eval/questions.json`: 15 perguntas com nota correta esperada e 4 controles negativos (assuntos ausentes dos vaults).

Baseline em 2026-08-12:

| Métrica | Valor | Leitura |
|---|---|---|
| Recall@1 | 87% | nota certa em primeiro |
| Recall@5 | **100%** | o trecho certo sempre chega ao contexto do LLM |
| MRR | 0,933 | premia ranquear melhor, não só encontrar |
| Separação | **−0,091** | ⚠️ ver abaixo |

**Limitação conhecida e importante:** a pontuação de similaridade é **ordinal, não probabilidade**. Ela ordena os resultados entre si; não mede relevância absoluta. Um exemplo real:

```
"como TROCAR o óleo do câmbio"  → 0,468   (casou com "## Por que TROCAMOS")
"o que ficou pendente pra Ana?" → 0,377   (acerto legítimo)
```

Esse número **piora conforme o vault cresce**: acrescentar documentação falando em "trocar" empurrou o falso positivo de 0,433 para 0,468 numa única sessão. Rodar `npm run eval` periodicamente, e não só ao mexer no código, é o que revela esse tipo de degradação silenciosa.

Nenhum limiar numérico separa os dois. Por isso quem julga relevância é o Claude, lendo o conteúdo: a descrição da ferramenta instrui a dizer "não encontrei registro" em vez de responder a partir de coincidência de palavras, e a saída avisa quando nem o melhor resultado é forte. O conserto estrutural seria busca híbrida (semântica + palavra exata), ainda no backlog.

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

## Onde ficam suas anotações

Em pastas normais do seu computador, como arquivos de texto que qualquer editor abre. **Nada fica preso na ferramenta.**

Cada projeto tem sua própria gaveta, chamada de **vault**. Isso não é frescura organizacional — se tudo ficasse junto, perguntar *"por que escolhemos Postgres?"* traria a resposta de três projetos misturados, um deles tendo decidido o contrário. A resposta viria confusa ou errada.

## Adicionando um projeto novo

Duas situações:

**Seu projeto já tem documentação escrita?** Aponte para a pasta dela. Nada é copiado — os arquivos continuam onde estão, você continua editando como sempre, e a ferramenta lê de lá.

**Seu projeto não tem nada escrito?** Crie uma pasta dentro de `notes/` e comece a anotar por conversa.

Nos dois casos você edita o arquivo `vaults.json` (o exemplo está na Parte 1) e roda:

```bash
npm run ingest
```

Da primeira vez pode demorar — ela precisa "ler" tudo. Projeto grande, de umas 100 páginas de documentação, leva algo como meia hora. **Só a primeira vez.** Depois, mudanças custam menos de um segundo.

## Uma rotina que funciona

- **Terminou uma discussão técnica?** "anota aí o que decidimos e por quê"
- **Vai começar uma tarefa numa parte do código que não toca há tempo?** "o que eu já decidi sobre essa parte?"
- **Alguém te pergunta por que o sistema é assim?** Pergunte antes de responder de memória.
- **Toda sexta**, se lembrar: "o que decidi essa semana que ainda não está anotado?"

## Duas coisas honestas

**1. Se você não anotar, ela não serve para nada.** Não existe mágica: a ferramenta responde a partir do que você escreveu. Por isso anotar foi feito para custar uma frase — o objetivo é remover toda desculpa para não fazer.

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
