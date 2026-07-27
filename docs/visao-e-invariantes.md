# Visão e invariantes

## Definição

Uma **AI Engine** é um componente de software versionado que publica capabilities
reutilizáveis de domínio, apoiadas por IA, por contratos estáveis. Modelos,
prompts, dados, retrieval e ferramentas permanecem detalhes internos
substituíveis.

Uma implementação é uma AI Engine quando publica ao menos uma operação orientada
a domínio, valida entrada e saída, encapsula a implementação de IA, permite reuso
por mais de um canal e possui unidade clara de versionamento e ownership.

## Responsabilidades distintas

- **AI Engine:** entrega capabilities de domínio reutilizáveis e contratadas.
- **Harness:** gerencia mensagens, ferramentas, memória, ambiente e execução de um
  agente.
- **Loop:** decide o próximo passo, repete trabalho e encerra ao atingir uma meta.
- **Framework:** fornece contratos, runtime e adapters; não é uma engine de domínio.

Um produto pode acumular essas responsabilidades, mas o core NÃO DEVE acoplá-las.
Wrapper de modelo, coleção de prompts, gateway multi-modelo, servidor que apenas
espelha APIs, harness ou workflow engine não são por si só uma AI Engine.

## Invariantes

**AE-INV-01 — Capability first.** A interface pública DEVE representar uma ação de
domínio, como `support.classify-ticket`, e NÃO DEVE representar infraestrutura,
como `llm.complete`.

**AE-INV-02 — Contrato estável.** Entrada e saída DEVEM ser validadas em runtime e
descritas por schema. O consumidor NÃO DEVE precisar conhecer prompt, modelo,
retrieval ou fallback.

**AE-INV-03 — Implementação substituível.** Modelo, provider, prompt, banco,
vector store e ferramenta PODEM mudar sem alterar o contrato público compatível.

**AE-INV-04 — Reuso.** A mesma capability DEVE poder ser invocada diretamente,
pela CLI e por MCP sem duplicar o handler.

## Contratos conceituais

**AE-CAP-01 — Capability mínima.** Toda capability DEVE declarar exatamente os
cinco elementos obrigatórios: `description`, `input`, `output`, `access` e `run`.
`title`, `timeoutMs` e `annotations` são opcionais. O ID NÃO fica na definição; é
a chave usada em `createEngine`.

**AE-ENG-01 — Engine mínima.** Toda engine DEVE declarar `name`, `version` e
`capabilities`. `logger` e `onEvent` são opcionais. A API pública resultante
oferece `invoke`, `list` e `describe`.

**AE-SCHEMA-01 — Standards existentes.** `input` e `output` DEVEM ser compatíveis
simultaneamente com Standard Schema v1, para validação e inferência, e Standard
JSON Schema v1, para descrição nos adapters. O framework NÃO DEVE inventar outra
abstração de schema nem depender de Zod no core.

**AE-SCHEMA-02 — Objeto JSON.** Input e output DEVEM ser serializáveis como JSON e
ter schema raiz de objeto. Ambos são obrigatórios. Input é validado e transformado
antes de autorização e execução; output é validado e transformado antes do retorno.

**AE-ACCESS-01 — Regra explícita.** Toda capability DEVE declarar `access` como
`public`, `authenticated` ou função assíncrona/síncrona. `public` aceita
`principal = null`; `authenticated` exige `Principal`; função só permite quando
retorna `true`.

**AE-CTX-01 — Contexto mínimo.** `ExecutionContext` DEVE conter somente
`requestId`, `source`, `principal`, `signal` e `logger`. `source` é `direct`,
`cli`, `mcp-stdio` ou `mcp-http`. O contexto NÃO DEVE conter service locator,
registry de ports, error factory, policy context ou metadata bag mutável.

**AE-PRINCIPAL-01 — Identidade mínima.** `Principal` DEVE conter `id` e PODE
conter `attributes` somente leitura. Roles, scopes, tenants, groups e claims não
são padronizados; quando necessários, ficam em `attributes`.

## Maturidade

A v0.1 resolve o nível B, capability contratada, e o nível C, engine reutilizável.
Oferece pontos mínimos para o nível D por autenticação plugável, autorização e
eventos. NÃO DEVE tentar implementar a plataforma federada do nível E.
