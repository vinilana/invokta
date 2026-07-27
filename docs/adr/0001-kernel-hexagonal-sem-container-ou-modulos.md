# ADR 0001: Kernel hexagonal sem container ou módulos de runtime

- Status: Accepted
- Data: 2026-07-27

## Contexto

O kernel precisa executar as mesmas operações por chamadas programáticas, CLI,
MCP e HTTP. Se regras de negócio dependerem de um framework de transporte, de um
container de injeção de dependências ou de registro implícito de módulos, cada
entrada passa a ter comportamento próprio e a composição fica difícil de testar.

Neste ADR, “módulo” significa uma unidade de registro ou descoberta em runtime;
não se refere a módulos ESM da linguagem.

## Decisão

O `@ai-engine/core` adotará arquitetura hexagonal:

- o kernel conterá capabilities, tipos públicos, invariantes e pipeline;
- portas de modelo, dados e ferramentas serão interfaces da engine customizada,
  não registros administrados pelo framework;
- integrações externas serão implementações injetadas nessas interfaces;
- dependências entrarão por construtores ou funções-fábrica explícitas;
- a composição acontecerá na borda da aplicação, sem estado global mutável;
- dependências apontarão das bordas para o core, nunca do core para as bordas.

O kernel não terá registry de ports, container de injeção de dependências,
service locator,
decoradores de registro, reflexão para descoberta ou sistema de `modules` com
hooks de inicialização. Adicionar uma operação ou um adaptador exigirá importação
e ligação explícitas no ponto de composição.

## Consequências

- O mesmo kernel pode ser exercitado sem inicializar CLI, servidor HTTP ou MCP.
- Testes podem substituir portas por doubles simples, sem infraestrutura de
  container.
- Dependências e ordem de inicialização ficam visíveis no código.
- O wiring será mais explícito e, em composições grandes, um pouco mais verboso.
- Conveniências de framework só podem existir em adaptadores e não podem vazar
  para os contratos públicos do core.
