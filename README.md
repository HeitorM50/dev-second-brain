# dev-second-brain

**AI Second Brain for Developers** — um segundo cérebro que registra conversas, preserva o contexto de projetos e responde, em linguagem natural, perguntas sobre decisões passadas.

---

## Visão geral

No dia a dia de desenvolvimento, contexto se perde com facilidade:

- Decisões técnicas tomadas semanas atrás cujo motivo ninguém mais lembra.
- Discussões relevantes que se dissolvem no histórico de mensagens.
- Justificativas de escolhas ("por que adotamos essa biblioteca?") que nunca ficam documentadas.

O `dev-second-brain` captura esse conhecimento e permite consultá-lo por meio de perguntas em linguagem natural, tratando a memória do projeto como uma base pesquisável em vez de um arquivo morto.

## Funcionalidades

- **Registro de conversas** — armazenamento e recuperação de discussões e trocas anteriores.
- **Contexto por projeto** — cada projeto mantém sua própria base de memória isolada.
- **Busca semântica de decisões** — consultas em linguagem natural sobre o histórico, com recuperação por significado (RAG) e não apenas por correspondência de palavras-chave.
- **Agente de busca** — cruza múltiplas fontes para compor respostas fundamentadas.

## Arquitetura

A stack está em definição; parte do objetivo do projeto é avaliar as alternativas em cada camada antes de fixá-las.

| Camada | Tecnologia |
|---|---|
| Frontend / Aplicação | Next.js |
| Orquestração de agentes | LangGraph ou OpenAI Agent SDK |
| Busca semântica | RAG com pgvector ou Pinecone |
| Cache / memória de curto prazo | Redis |

Decisões de stack em aberto (por exemplo, pgvector vs. Pinecone e LangGraph vs. Agent SDK) serão registradas conforme forem tomadas.

## Getting Started

> Em construção. As instruções de instalação e execução serão adicionadas assim que a estrutura inicial da aplicação estiver definida.

## Roadmap

- [ ] Definição da stack e estrutura inicial do projeto
- [ ] Ingestão e armazenamento de conversas
- [ ] Pipeline de RAG (embeddings + banco vetorial)
- [ ] Contexto isolado por projeto
- [ ] Agente de busca sobre múltiplas fontes

## Status

Fase inicial — estrutura e definição da stack em andamento.

---

Desenvolvido por [@HeitorM50](https://github.com/HeitorM50).
