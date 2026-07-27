# Escopo e limites da v0.1

## Packages públicos

**AE-SCOPE-01 — Três packages.** A versão 0.1 possui somente:

| Package | Responsabilidade |
| --- | --- |
| `@ai-engine/core` | Capability, Engine, Context, Principal, validação, acesso, erros e eventos |
| `@ai-engine/cli` | `list`, `describe`, `run`, JSON por argumento/stdin e renderização |
| `@ai-engine/mcp` | tools por stdio e Streamable HTTP stateless |

Os packages são ESM. Core não tem dependência de runtime além de, quando
necessário, `@standard-schema/spec`. CLI e MCP dependem apenas da API pública do
core para executar capabilities.

## O que pertence a cada camada

**AE-SCOPE-02 — Framework.** O framework oferece definição tipada, validação,
registro em uma engine, execução direta, contexto mínimo, access enforcement,
eventos e adapters CLI/MCP.

**AE-SCOPE-03 — Engine customizada.** Capabilities, prompts, recipes, integrações
com modelos/dados, regras de negócio, autorização de domínio, evals, métricas e
lifecycle das dependências pertencem à engine construída pelo usuário.

**AE-SCOPE-04 — Evolução por extração.** Auth pronto, OpenTelemetry, evals, model
adapters, routing, cache, context compilation, scaffold e generators só podem
nascer após repetição comprovada em engines reais.

## Limites explícitos

| Dimensão | Limite v0.1 |
| --- | --- |
| Packages públicos | 3 |
| Adapters oficiais | CLI e MCP |
| Transportes MCP | stdio e Streamable HTTP stateless |
| Primitivas do core | Capability, Engine, Context, Principal |
| Campos obrigatórios de capability | 5 |
| Fases do pipeline | 6 |
| Códigos de erro | 7 |
| Hooks transversais | 1: `onEvent` |
| Implementações de auth/PDP | 0 |
| Containers, modules ou plugins | 0 |

**AE-LIMIT-01 — Runtime.** Não fazem parte: lifecycle universal, fila,
concorrência, retries automáticos, distributed execution, jobs, scheduler,
streaming arbitrário e progress API.

**AE-LIMIT-02 — Arquitetura.** Não fazem parte: modules formais, port registry,
dependency container, plugin loading, manifest compiler e registry remoto.

**AE-LIMIT-03 — IA e qualidade.** Não fazem parte: model router, context compiler,
memória, RAG abstraction, prompt registry, providers oficiais, cache semântico,
economics engine, eval runner, LLM-as-judge, release gates e canary.

**AE-LIMIT-04 — Segurança.** Não fazem parte: auth package, JWT/JWKS,
introspection universal, DPoP, mTLS, linguagem RBAC/ABAC, grafo ReBAC, PDP adapter,
session binding e Authorization Server.

**AE-LIMIT-05 — MCP.** Não fazem parte: resources, prompts, sampling, elicitation,
tasks, sessões stateful, resumption e requests server-to-client.

## Gatilhos de evolução

Uma extensão só entra após evidência. Exemplos: auth OAuth após três engines
repetirem a integração; PDP adapter após duas engines repetirem o mesmo vendor;
modules quando object spread falhar para ownership real; lifecycle quando várias
dependências repetirem start/stop; evals e OpenTelemetry quando duas engines
compartilharem a mesma necessidade.
