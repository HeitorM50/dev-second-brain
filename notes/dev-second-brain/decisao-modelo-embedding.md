# Decisão: modelo de embedding

**Status:** decidido em 2026-08-11.

## O que ficou decidido

Usar **bge-m3** rodando localmente no Ollama, substituindo o `nomic-embed-text`
que estava em uso antes.

## Por que trocamos

O `nomic-embed-text` é treinado essencialmente em inglês. Com notas em português
ele produzia vetores que quase não se distinguiam entre si: todas as pontuações
espremidas entre 0,41 e 0,67. A pergunta "qual tecnologia vamos usar para montar
as telas?" trazia a nota certa apenas em 13º lugar de 15.

O sinal mais claro veio de um teste de controle deliberadamente absurdo: perguntar
sobre "receita de bolo de cenoura" pontuava 0,62 — mais alto que a maioria dos
trechos legítimos. Uma busca que não sabe dizer "não sei" não está funcionando.

Com o bge-m3 a mesma pergunta acerta em 1º lugar e o controle cai para 0,26.

## Alternativas consideradas

- **paraphrase-multilingual:** mais leve (560 MB contra 1,2 GB) e também
  multilíngue, mas com qualidade menor em textos técnicos longos.
- **API da OpenAI:** boa qualidade, porém paga e os textos sairiam da máquina —
  contraria a ideia de manter os dados sob controle próprio.

## Hipóteses testadas e descartadas

Antes de trocar o modelo, duas suspeitas foram medidas e não se confirmaram:
prefixos de tarefa (`search_query:` / `search_document:`) e a remoção do carimbo
`Fonte:` no início de cada chunk. Nenhuma das duas alterou o ranking.

## Consequência importante

Trocar o modelo de embedding invalida o índice inteiro, porque vetores de modelos
diferentes não são comparáveis. Por isso o arquivo de índice grava qual modelo o
gerou e descarta o cache quando não bate.
