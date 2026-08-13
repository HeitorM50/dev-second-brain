# Decisão: autenticação com sessão própria

_Registrado em 2026-08-13._

## O que ficou decidido

O TaskFlow vai usar sessão própria com cookie assinado, em vez de provedor externo.

## Por quê

- Não queremos depender de um fornecedor para algo tão central quanto login.
- O time já conhece o padrão e não há requisito de SSO corporativo.

## Alternativas consideradas

- **Auth0 / Clerk:** rápido de integrar, mas custo por usuário e mais um fornecedor no caminho crítico.
- **OAuth com GitHub:** bom para produto de dev, mas exclui usuários sem conta no GitHub.
