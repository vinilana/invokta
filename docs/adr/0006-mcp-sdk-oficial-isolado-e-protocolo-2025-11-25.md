# ADR 0006: SDK oficial do MCP isolado e protocolo `2025-11-25`

- Status: Accepted
- Data: 2026-07-27

## Contexto

O suporte ao Model Context Protocol exige interoperabilidade precisa, mas o SDK é
uma dependência de transporte sujeita a evolução independente do kernel. Fixar um
número de versão sem verificar compatibilidade com a revisão de protocolo adotada
criaria uma garantia falsa.

## Decisão

`@ai-engine/mcp` implementará a integração com o SDK oficial do MCP. Imports,
tipos concretos, objetos de transporte e detalhes de ciclo de vida desse SDK
ficarão confinados a `packages/mcp`; nenhum deles fará parte da API pública nem
dos tipos de `@ai-engine/core`.

O adaptador terá como revisão normativa do protocolo a string exata
`2025-11-25`. Handshake, capacidades, mensagens e testes de conformidade deverão
ser compatíveis com essa revisão. Traduções entre MCP e o modelo do engine
acontecerão na fronteira e toda execução de tool convergirá para `invoke`.

A versão aprovada é `@modelcontextprotocol/sdk@1.29.0`, fixada exatamente no
manifest e no lockfile, sem `^`, `~` ou o rótulo `latest`. A versão 1.29.0 declara
`2025-11-25` como protocolo mais recente e suportado. Os packages v2 permanecem
beta na data desta decisão e não serão usados na versão 0.1 do framework.

Como defesa adicional, a integração não importará o entrypoint raiz afetado pelo
problema conhecido de empacotamento da versão 1.29.0; usará somente os subpaths
documentados e cobertos por smoke tests. Uma atualização do SDK deverá verificar
novamente protocolo, exports, runtime, notas de release e correções de segurança.

Não será mantida uma implementação própria completa do protocolo em paralelo ao
SDK oficial; código local se limitará à adaptação, isolamento e testes.

## Consequências

- Atualizações ou breaking changes do SDK ficam contidos no package MCP.
- O core permanece utilizável sem instalar o SDK.
- A revisão de protocolo pode ser testada como contrato explícito.
- O lockfile e os testes de integração tornam a revisão reproduzível.
- Atualizar o SDK exigirá repetir a pesquisa de compatibilidade e executar os
  testes de conformidade.

## Evidências da decisão

- [Constantes de protocolo do SDK 1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts#L4-L6)
- [Manifest do SDK 1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/package.json)
- [Especificação MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Problema conhecido do entrypoint raiz](https://github.com/modelcontextprotocol/typescript-sdk/issues/971)
