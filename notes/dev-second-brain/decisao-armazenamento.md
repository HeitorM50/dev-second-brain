---
data: 2026-08-11
projeto: dev-second-brain
tags: [indice, armazenamento, decisao]
status: ativo
---

# Decisão: onde guardar o índice vetorial

**Status:** decidido em 2026-08-11.

## O que ficou decidido

Arquivo **JSON em disco**, um por vault, com busca por varredura linear feita em
código próprio.

## Por que JSON e não um banco

Com o volume atual, qualquer banco seria infraestrutura sem contrapartida. Além
disso, escrever a similaridade de cosseno à mão é justamente o conceito central a
aprender — um banco esconderia a matemática atrás de uma query.

Os dados também ficam inspecionáveis a olho nu, o que ajuda a depurar.

## Alternativas consideradas

- **SQLite com extensão vetorial:** um arquivo só, sem servidor, com índice
  aproximado de verdade. Melhor para volume grande, mas esconde o cálculo.
- **Postgres + pgvector:** seria necessário se a interface fosse uma aplicação
  web, que recarrega o estado a cada requisição. Como a interface escolhida é
  local (Claude Code via MCP, e eventualmente um app instalado), o processo fica
  vivo e mantém o índice em memória — o banco deixou de ser necessário.

## Até quando isso escala

O gargalo não é a velocidade da busca, e sim o tempo de carregar e parsear o
arquivo. A varredura em si custa milissegundos mesmo com milhares de trechos.

Com vaults separados por projeto, o teto passou a valer por projeto e não no
total, o que empurra a migração para bem longe.

## Como reverter, se precisar

A decisão é barata de desfazer porque o índice é derivado das notas. Toda a
persistência está isolada em `src/store.ts`: trocar de tecnologia significa
reescrever aquele arquivo e reindexar.
