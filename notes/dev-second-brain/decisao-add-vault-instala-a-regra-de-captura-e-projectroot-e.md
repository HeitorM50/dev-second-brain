---
data: 2026-08-14
projeto: dev-second-brain
status: ativo
---

# Decisão: add_vault instala a regra de captura, e projectRoot é o consentimento

_Registrado em 2026-08-14._

## O que ficou decidido

O `add_vault` ganhou o parâmetro opcional `projectRoot`:

- **Omitido** → comportamento antigo: o bloco de instrução é apenas impresso como sugestão, nenhum arquivo é tocado.
- **Informado** → o bloco é gravado no `CLAUDE.md` daquele caminho.

A presença do parâmetro **é** o sinal de consentimento: a descrição da ferramenta instrui o Claude a perguntar antes de preenchê-lo. Escrita dentro do repositório de outro projeto nunca acontece por padrão.

## Por quê

A causa de o vault `grupo03` estar com zero notas não era falta de disciplina — era estrutural. O `add_vault` imprimia o bloco e dependia de alguém copiar e colar. Ninguém colou nunca, nem no `grupo03` nem neste próprio repositório.

Melhorar o **texto** do bloco não resolveria nada, porque o problema nunca foi o texto: era ele nunca chegar ao arquivo.

## Regras de escrita

Como isso mexe em repositório alheio, o comportamento é conservador:

| Situação | O que acontece |
|---|---|
| `CLAUDE.md` não existe | cria com o bloco |
| `CLAUDE.md` existe | acrescenta ao fim — **nunca sobrescreve** |
| Já contém o título do bloco | não duplica; reporta que já estava lá |
| Caminho inexistente | erro claro, vault preservado |

Um vault **já registrado** também aceita a instalação sem ser recadastrado. Isso cobre todo projeto adicionado antes desta regra existir — incluindo o `grupo03`.

## Alternativas consideradas

- **Deduzir a raiz do projeto a partir de `sources`:** as fontes apontam para pastas de documentação (`<projeto>/docs`), e subir um nível seria adivinhação. Além disso, um parâmetro explícito serve de consentimento; um caminho deduzido não serviria.
- **Regra global em `~/.claude/CLAUDE.md`:** funcionaria em todo projeto sem instalar nada, e combinaria com o MCP já ser de escopo de usuário. Descartada porque precisaria de uma trava para não disparar em projeto sem vault, e deduzir o vault pela pasta ainda é item de backlog. Com o bloco por projeto, a própria presença dele é a trava.
- **Instalar sempre, sem parâmetro:** descartado — gravar em repositório de trabalho ou de grupo sem autorização explícita não é aceitável.
