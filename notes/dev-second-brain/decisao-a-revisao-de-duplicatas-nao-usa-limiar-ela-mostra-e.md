---
data: 2026-08-14
projeto: dev-second-brain
status: ativo
---

# Decisão: a revisão de duplicatas não usa limiar, ela mostra e o Claude julga

_Registrado em 2026-08-14._

## O que ficou decidido

A ferramenta `review_decisions` **não decide** se uma decisão já está registrada. Ela recebe as decisões candidatas de uma conversa, busca as notas mais próximas de cada uma e devolve os trechos para o Claude ler e julgar.

Não existe limiar do tipo "acima de 0,7 é duplicata".

## Por quê

Foi medido, e o número não separa. Numa chamada de teste com quatro decisões no vault `dev-second-brain`:

- "adotar Kubernetes para orquestrar os contêineres" → **0,516**
- "trocar o gerenciador de pacotes por pnpm" → **0,526**

Nenhuma das duas existe em lugar nenhum do acervo, e ambas passaram acima do aviso de semelhança fraca (0,40). Num vault cheio de texto sobre engenharia de software, qualquer coisa técnica encosta em 0,5.

É a mesma limitação já documentada para a busca em geral: **a pontuação ordena, mas não julga**. Ela diz "o trecho A é mais parecido que o B", não "o trecho A responde".

## O erro que isso quase causou

A primeira versão fazia o aviso ⚠ **substituir** a lista de notas vizinhas. Como o aviso quase nunca dispara num vault real, a ausência dele passaria a ser lida como "então já está registrado" — e a ferramenta criada para evitar duplicata começaria a **bloquear notas legítimas**.

Correção: o ⚠ virou uma linha extra, nunca um substituto, e o cabeçalho diz explicitamente que semelhança alta não prova cobertura.

## Alternativas consideradas

- **Limiar automático de duplicata:** descartado pela medição acima. Seria repetir o erro da cobertura lexical, que também foi construída, medida e reprovada por cortar acertos legítimos.
- **Não criar ferramenta e usar o `search_notes` uma vez por decisão:** funcionalmente equivalente, mas nada obrigaria o Claude a fazer isso — a mesma fragilidade de "depender de lembrar" que o projeto está tentando resolver. A descrição da ferramenta é o que torna o ritual confiável.
