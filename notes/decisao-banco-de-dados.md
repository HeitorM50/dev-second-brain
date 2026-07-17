# Decisão: camada de persistência

**Status:** decidido em 2026-07-10 (ver [[reuniao-2026-07-10]]).

## O que ficou decidido

Vamos usar **PostgreSQL** como banco principal do TaskFlow.

## Alternativas consideradas

- **MongoDB:** flexível para dados sem esquema fixo, mas nossos dados (tarefas,
  quadros, usuários) são claramente relacionais e cheios de referências entre si.
- **Firebase / Firestore:** rápido de começar, mas nos prenderia ao fornecedor e
  dificultaria consultas mais complexas.

## Por que Postgres

- Os dados são relacionais e se beneficiam de integridade referencial e transações.
- É maduro, gratuito e portátil.
- Se um dia precisarmos de busca semântica, a extensão `pgvector` permite guardar
  vetores no mesmo banco, sem subir um serviço separado.

Encaixa na visão descrita em [[arquitetura-geral]].
