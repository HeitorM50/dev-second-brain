---
data: 2026-08-14
projeto: dev-second-brain
status: ativo
---

# Decisão: captura de fim de sessão por regra escrita, não por hook

_Registrado em 2026-08-14._

## O que ficou decidido

A captura automática de decisões é uma **instrução escrita no `CLAUDE.md` de cada projeto**, não um mecanismo de código. O bloco instala o ritual: revisar a conversa, checar o que já está registrado e gravar as decisões novas.

O gatilho são os dois momentos que o Claude **consegue observar**:

1. O Heitor sinalizar que está encerrando ("é isso por hoje", "pode parar", "vamos commitar");
2. Sempre antes de um commit.

## Por quê

O `save_note` já funcionava, mas exigia que alguém lembrasse de pedir. Na prática a decisão é tomada no meio do trabalho, o registro fica "para depois", e depois nunca chega. A evidência era o vault `grupo03`: 1.543 trechos indexados, **zero notas** criadas por conversa.

A regra escrita resolve isso com zero código e é testável imediatamente. E "fim de sessão" não é um evento que o modelo perceba — por isso o gatilho foi ancorado em sinais observáveis, em vez de depender de o Claude adivinhar que o trabalho acabou.

## Alternativas consideradas

- **Hook do Claude Code (`Stop` / `SessionEnd`):** é o único mecanismo que observa o encerramento de verdade, sem depender de sinal. Descartado por ora: mora fora do projeto (configuração global), fica intrusivo se mal calibrado — o `Stop` dispara a cada resposta — e o `SessionEnd` não consegue oferecer nada, porque a sessão já acabou. Fica reservado para o caso de a regra escrita falhar na prática.
- **Ser proativo ao fim de cada tarefa:** pegaria mais decisões, mas "bloco de trabalho fechou" é julgamento subjetivo e viraria interrupção repetida no meio da sessão.
- **Só quando o Heitor sinalizar:** mais conservador, mas se ele fechar o terminal sem falar nada — o caso comum — a captura não acontece e o problema continua de pé.

## Limitação conhecida

Esta é a primeira melhoria que o `npm run eval` **não mede**. A suíte avalia busca, não captura. A verificação real é o vault crescer com notas que valham a pena reler.
