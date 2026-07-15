# 🧠 dev-second-brain

> **AI Second Brain for Developers** — um segundo cérebro que lembra das suas conversas, guarda o contexto dos seus projetos e responde *"o que a gente decidiu semana passada?"*.

Projeto pessoal de férias, com foco duplo: **produtividade pessoal** e **aprender na prática** um stack moderno de aplicações com IA (agents + RAG).

---

## 💡 O problema

Como dev, contexto se perde o tempo todo:

- Decisões técnicas tomadas semanas atrás que ninguém lembra o porquê.
- Conversas e discussões importantes que somem no histórico.
- "Por que a gente escolheu essa lib mesmo?"

O **dev-second-brain** captura esse conhecimento e deixa você **conversar com a sua própria memória**.

## ✨ O que ele vai fazer

- 🗣️ **Relembrar conversas** — busca sobre discussões e trocas passadas.
- 📁 **Guardar contexto de projetos** — cada projeto com sua própria memória.
- 🔎 **Pesquisar decisões antigas** — *"o que decidimos semana passada?"* como pergunta em linguagem natural.
- 🤖 **Agente de busca** — responde perguntas cruzando fontes via RAG, não só keyword match.

## 🛠️ Tech Stack (planejada)

| Camada | Tecnologia |
|---|---|
| Frontend / App | **Next.js** |
| Orquestração de agentes | **LangGraph** / **OpenAI Agent SDK** |
| Busca semântica | **RAG** com **pgvector** ou **Pinecone** |
| Cache / sessões | **Redis** |

> ⚠️ Stack em definição — parte do objetivo é experimentar e comparar as opções (ex.: pgvector vs. Pinecone, LangGraph vs. Agent SDK).

## 🎯 Objetivos de aprendizado

- Construir um pipeline de **RAG** do zero.
- Entender **orquestração de agentes** com estado.
- Trabalhar com **embeddings** e bancos vetoriais.
- Usar **Redis** para cache e memória de curto prazo.

## 🗺️ Status

🚧 **Em fase inicial** — começando pela estrutura e definição do stack.

---

Feito por [@HeitorM50](https://github.com/HeitorM50) 🚀
