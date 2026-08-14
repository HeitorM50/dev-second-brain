---
data: 2026-08-14
projeto: dev-second-brain
status: ativo
---

# Decisão: uma nota por decisão, nunca nota-diário de sessão

_Registrado em 2026-08-14._

## O que ficou decidido

Quando a revisão de fim de sessão encontra várias decisões, cada uma vira **um arquivo separado** — uma chamada de `save_note` por decisão. Nunca uma nota única do tipo "Sessão 14/08 — decidimos A, B e C".

Cada nota responde três coisas: o que ficou decidido · por quê · o que foi descartado.

## Por quê

É uma consequência direta de como a busca funciona. O índice fatia as notas **por seção**, e a busca compara o vetor da pergunta com o vetor de cada trecho.

Um trecho que mistura três assuntos diferentes gera um vetor que fica no "meio do caminho" entre eles — e não casa forte com pergunta nenhuma. Ele dilui a busca em vez de ajudar. Uma nota sobre um assunto só produz um vetor concentrado, que casa forte com perguntas sobre aquele assunto.

Com o Recall@5 em 97%, o risco de degradar era concreto e não valia a economia de arquivos.

## Alternativas consideradas

- **Uma nota de sessão (diário):** mais fiel ao fluxo do dia e gera menos arquivos. Descartada pelo motivo acima — o custo cai direto na qualidade da busca, que é o que a ferramenta existe para fazer.
- **Nota por decisão + índice de sessão com wikilinks:** cobriria os dois usos. Descartada por enquanto: mais escrita a cada sessão, e a expansão por grafo via `[[links]]` já foi construída, medida e desligada por não trazer ganho neste tamanho de acervo. O índice de sessão só teria valor se os links fossem usados na busca.
