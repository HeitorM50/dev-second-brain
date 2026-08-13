---
data: 2026-07-05
projeto: taskflow
tags: [arquitetura, visao-geral]
status: ativo
---

# Arquitetura geral — TaskFlow

TaskFlow é um app de gerenciamento de tarefas com colaboração em tempo real.

## Visão em camadas

- **Frontend:** aplicação web (ver [[stack-frontend]]).
- **Backend:** API REST que expõe tarefas, quadros e usuários.
- **Persistência:** banco relacional (ver [[decisao-banco-de-dados]]).
- **Tempo real:** canal de eventos para sincronizar quadros entre usuários abertos
  na mesma tela.

## Princípios que combinamos

- Manter o backend simples enquanto não houver necessidade real de escalar.
- Evitar adicionar serviços novos (fila, cache) antes de sentir a dor.
- Toda decisão técnica relevante vira uma nota aqui, com o motivo.

Decisões recentes discutidas na [[reuniao-2026-07-10]].
