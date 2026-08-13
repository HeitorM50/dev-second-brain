---
data: 2026-07-10
projeto: taskflow
tags: [frontend, stack, decisao]
status: ativo
---

# Stack de frontend — TaskFlow

## Escolha

A interface do TaskFlow será construída com **Next.js** e **React**, usando
**TypeScript** em todo o código.

## Motivos

- Renderização no servidor melhora o carregamento inicial dos quadros.
- Roteamento e organização de páginas já vêm prontos.
- TypeScript reduz erros bobos e documenta os formatos de dados.

## Estilização

Combinamos usar utilitários de CSS (Tailwind) para ir rápido, e só extrair
componentes reutilizáveis quando um padrão se repetir três vezes ou mais.

## Em aberto

- Biblioteca de componentes ainda não definida.
- Estratégia de tema (claro/escuro) fica para depois do MVP.

Contexto geral em [[arquitetura-geral]].
