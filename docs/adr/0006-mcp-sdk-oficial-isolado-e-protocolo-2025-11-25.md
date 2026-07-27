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

A versão do SDK ainda não está decidida. Antes de adicionar a dependência, será
feita pesquisa nas fontes oficiais para verificar, no mínimo, suporte explícito
ao protocolo `2025-11-25`, compatibilidade com o runtime adotado, notas de release
e correções de segurança. A versão aprovada será registrada neste ADR ou em um
ADR que o substitua, fixada exatamente no manifest e no lockfile, sem `^`, `~` ou
o rótulo `latest`. Até essa pesquisa terminar, nenhum número de versão de SDK é
considerado normativo.

Não será mantida uma implementação própria completa do protocolo em paralelo ao
SDK oficial; código local se limitará à adaptação, isolamento e testes.

## Consequências

- Atualizações ou breaking changes do SDK ficam contidos no package MCP.
- O core permanece utilizável sem instalar o SDK.
- A revisão de protocolo pode ser testada como contrato explícito.
- A implementação da integração fica bloqueada até a escolha documentada de uma
  versão exata e verificada do SDK.
- Atualizar o SDK exigirá repetir a pesquisa de compatibilidade e executar os
  testes de conformidade.
