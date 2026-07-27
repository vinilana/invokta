# ADR 0002: Standard Schema e Standard JSON Schema como contratos de schema

- Status: Accepted
- Data: 2026-07-27

## Contexto

Operações precisam descrever e validar entradas e saídas, enquanto adaptadores
precisam expor esses contratos para ferramentas e protocolos. Amarrar a API
pública a uma biblioteca de validação específica reduziria a interoperabilidade
e transformaria uma escolha de implementação em requisito para todo consumidor.

## Decisão

Cada schema executável aceito pelo core obedecerá simultaneamente aos contratos
Standard Schema e Standard JSON Schema. Assim, a mesma declaração valida e
transforma valores em runtime e fornece a representação JSON Schema consumida
pelos adapters. A versão 0.1 não terá conversor ou abstração própria de schema.

Input e output serão obrigatórios, serializáveis como JSON e terão objeto como
schema raiz para compatibilidade direta com MCP tools.

O core e seus tipos públicos não exportarão tipos, classes ou funções específicas
de Zod. Zod poderá aparecer somente em exemplos, fixtures e testes de integração
para demonstrar que uma implementação compatível com Standard Schema funciona.
Esses exemplos não tornam Zod uma dependência obrigatória nem a fonte normativa
dos contratos.

Adaptadores consumirão a representação padrão fornecida pela operação; não
reconstruirão schemas a partir de metadados particulares de uma biblioteca.

## Consequências

- Consumidores podem escolher validadores compatíveis sem alterar o kernel.
- Geração de documentação e exposição de tools usam um formato interoperável.
- Recursos exclusivos de uma biblioteca não podem ser presumidos pelo core.
- A validação e a obtenção do JSON Schema precisam de testes de contrato.
- Exemplos com Zod devem ser identificados como exemplos, não como API oficial.
