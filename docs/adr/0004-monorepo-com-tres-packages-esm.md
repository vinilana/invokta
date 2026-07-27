# ADR 0004: Monorepo com três packages ESM

- Status: Accepted
- Data: 2026-07-27

## Contexto

O projeto possui um kernel reutilizável e duas integrações distribuíveis, CLI e
MCP. Elas precisam evoluir juntas sem fundir suas dependências nem publicar
múltiplas variantes de módulos JavaScript.

## Decisão

O repositório será um monorepo com exatamente três packages de produto:

| Caminho | Nome publicado | Responsabilidade |
| --- | --- | --- |
| `packages/core` | `@ai-engine/core` | Kernel, contratos, pipeline e portas |
| `packages/cli` | `@ai-engine/cli` | Composição e interface de linha de comando |
| `packages/mcp` | `@ai-engine/mcp` | Adaptador do Model Context Protocol |

Os três packages serão ESM nativos, declararão `"type": "module"` e publicarão
somente entradas ESM por mapas de `exports`. Não haverá build CommonJS paralelo
nem uso de `require` na API publicada.

O package raiz será privado e coordenará workspace, lockfile e comandos de
qualidade. `@ai-engine/cli` e `@ai-engine/mcp` poderão depender de
`@ai-engine/core`; o core não dependerá deles, e CLI e MCP não dependerão um do
outro. Configurações e ferramentas internas não constituem packages de produto.

## Consequências

- Cada artefato mantém superfície pública e dependências próprias.
- Mudanças de contrato podem ser verificadas em todos os consumidores no mesmo
  workspace.
- Consumidores CommonJS precisarão usar interoperabilidade com ESM; não haverá
  artefato CJS mantido pelo projeto.
- O grafo de dependências impede que detalhes de transporte entrem no kernel.
- Publicação e versionamento precisam respeitar a compatibilidade entre os três
  packages.
