# Plano, TDD e critérios de aceite

## Regra de entrega

Cada fatia segue RED → GREEN → REFACTOR. O teste deve falhar primeiro pelo motivo
esperado, a implementação mínima deve torná-lo verde e a suíte afetada deve
permanecer verde após refatoração. Cada entregável validado termina em commit
próprio contendo testes, implementação e documentação correspondente.

## Marcos

### M0 — Walking skeleton

Entregar `defineCapability` e `createEngine` locais, uma capability de domínio com
Zod 4, chamada direta, access `public`/`authenticated` e ao menos cinco testes.
Provar DI sem container, rejeição de input/output inválidos e negação antes de
`run`.

### M1 — `@ai-engine/core`

Entregar tipos públicos, Standard Schema + Standard JSON Schema, `EngineError`,
`ExecutionContext`, cancelamento/timeout, `onEvent`, inferência em `invoke`, build
ESM e testes de tipo/runtime. Core não pode importar CLI, MCP, HTTP, IA ou identidade.

### M2 — CLI

Entregar `list`, `describe`, `run`, JSON por argumento/stdin, principal local,
stdout limpo, exit codes e integração exclusivamente por `engine.invoke`.

### M3 — MCP stdio

Entregar mapping para tools, input/output schema, `structuredContent`, error
mapping, propagação de cancelamento, principal local e teste com cliente MCP.

### M4 — MCP HTTP e autenticação

Entregar `/mcp` stateless, hook `authenticate`, Principal por request, Protected
Resource Metadata/challenge configurável, Host/Origin, bind seguro e testes com
token válido, ausente, inválido e principal proibido.

### M5 — Exemplos e documentação

Entregar `hello-engine`, `support-engine`, tutorial de chamada direta/CLI/MCP,
guia de IdP, guia de PDP por função e matriz de escopo/não escopo.

### M6 — Validação antes de expandir

Construir duas engines reais, integrar um harness por MCP, usar uma capability por
mais de um consumidor e registrar fricções. Extensões futuras só são avaliadas
depois dessa evidência; M6 não amplia a API da release 0.1.

## Matriz de rastreabilidade

| Requisito | Evidência mínima |
| --- | --- |
| `AE-INV-01..04` | Capability real reutilizada diretamente, por CLI e MCP sem duplicar `run` |
| `AE-CAP-01`, `AE-ENG-01` | Testes de tipo e runtime da API mínima, IDs por chave e `list`/`describe` |
| `AE-SCHEMA-01..02` | Input/output válidos transformam; inválidos geram códigos distintos; schemas raiz não objeto são recusados |
| `AE-ACCESS-01` | `public`, `authenticated` e função; negação nunca chama `run` |
| `AE-CTX-01`, `AE-PRINCIPAL-01` | Contexto contém apenas os campos normativos; Principal vem da borda |
| `AE-ARCH-01..03` | Grafo de imports e testes dos adapters provam direção e caminho único por `invoke` |
| `AE-PIPE-01`, `AE-ERR-01` | Testes instrumentam ordem, timeout/cancelamento, sete códigos e sanitização |
| `AE-OBS-01` | Três eventos, campos mínimos, duração e ausência de payload/credential |
| `AE-CLI-01..02` | Integração cobre comandos, argumento/stdin, stdout/stderr e exit 0/1/2 |
| `AE-MCP-01..04` | Cliente oficial lista/chama tools por stdio/HTTP; schemas, erros, cancelamento possível, stateless e proteção Host/Origin |
| `AE-SEC-01..02` | 401 antes de `invoke`; 403 antes de `run`; spoofing por input falha; auth insegura exige opt-in |
| `AE-SCOPE-01..04`, `AE-LIMIT-01..05` | Manifests e revisão da API comprovam três packages e ausência das abstrações adiadas |

## Gates finais da v0.1

- A documentação distingue framework, engine, harness e loop.
- A API pública do core permanece pequena e schemas/access são obrigatórios.
- A mesma capability funciona diretamente, por CLI, MCP stdio e MCP HTTP.
- CLI e MCP chamam somente `engine.invoke`; o SDK MCP fica isolado.
- HTTP protegido autentica antes de `invoke`; autorização ocorre antes de `run`.
- 401 e 403 mantêm semânticas distintas e tokens não aparecem em logs/eventos.
- Build ESM, typecheck, lint, testes unitários/integrados e smoke tests de package
  passam em ambiente limpo.
- Existem somente os três packages e os conceitos permitidos pela v0.1.
