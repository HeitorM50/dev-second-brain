---
data: 2026-07-20
projeto: dev-second-brain
tags: [embeddings, ollama, decisao]
status: superseded
superseded_by: decisao-modelo-embedding
---

# Decisão: embeddings locais com nomic-embed-text

**Status:** decidido em 2026-07-20, revisto em 2026-08-11.

## O que ficou decidido

Gerar os embeddings localmente com o Ollama, usando o modelo `nomic-embed-text`,
de 768 dimensões.

## Por quê

- **Grátis e privado:** os textos não saem da máquina, o que é coerente com a ideia
  de ser dono dos próprios dados.
- **Offline:** não depende de internet nem de chave de API.
- O modelo é pequeno e rápido — cerca de 0,22 segundo por trecho.

## Alternativas consideradas

- **API de embeddings da OpenAI:** boa qualidade e zero configuração, mas paga, e as
  notas pessoais sairiam da máquina.
- **Transformers.js:** roda em Node puro, sem processo externo, porém mais lento e
  com ergonomia pior.

A Anthropic não oferece API de embeddings, então usar o Claude para esta etapa nunca
foi opção.

## Por que esta decisão foi revista

O `nomic-embed-text` é treinado essencialmente em inglês. Com notas em português,
produzia vetores que quase não se distinguiam entre si, e a busca errava. A decisão
de rodar embeddings **localmente via Ollama** continua valendo — o que mudou foi o
modelo. Ver a decisão que substitui esta.
