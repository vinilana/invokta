# AI Engine Framework v0.1

Esta documentação é a fonte normativa para a implementação da versão 0.1.0. O
framework permite definir uma capability de domínio uma vez e executá-la por
chamada direta, CLI, MCP stdio e MCP Streamable HTTP stateless.

## Ordem de leitura

1. [Visão e invariantes](./visao-e-invariantes.md)
2. [Arquitetura e contratos](./arquitetura.md)
3. [Escopo e limites da v0.1](./escopo-v0.1.md)
4. [Plano e critérios de aceite](./plano-e-criterios-de-aceite.md)
5. [Registros de decisões arquiteturais](./adr/README.md)

## Linguagem normativa

Os termos **DEVE**, **NÃO DEVE**, **DEVERIA**, **PODE** e **OPCIONAL** indicam,
respectivamente, requisitos, proibições, recomendações e extensões permitidas.
Requisitos identificados como `AE-<ÁREA>-NN` são rastreados na matriz de aceite.

Em caso de conflito, a especificação de escopo e os ADRs mais recentes prevalecem
sobre exemplos. Uma mudança que amplie a API pública ou os conceitos da v0.1 exige
um caso real, um teste e uma decisão arquitetural explícita.

## Resultado de referência

Uma engine deve publicar a mesma capability sem duplicar regra de negócio:

```text
my-engine list
my-engine describe support.classify-ticket
my-engine run support.classify-ticket --input '{"ticketId":"T-123"}'
my-engine-mcp --transport stdio
my-engine-mcp --transport http --port 3000
```
