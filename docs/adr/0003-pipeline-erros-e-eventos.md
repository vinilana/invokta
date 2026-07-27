# ADR 0003: Pipeline único, erros estruturados e eventos observáveis

- Status: Accepted
- Data: 2026-07-27

## Contexto

CLI, MCP, HTTP e chamadas programáticas não podem divergir quanto a validação,
autorização, execução ou tratamento de falhas. Também é necessário observar uma
invocação sem acoplar o core a logs, métricas ou a um broker específico.

## Decisão

Toda execução de uma capability passará por um único pipeline do core, acionado
por `invoke`. A ordem normativa será:

1. gerar ou aceitar `requestId` e resolver a capability;
2. validar e transformar a entrada;
3. criar `ExecutionContext` e aplicar a regra `access`;
4. combinar o sinal recebido com o timeout e executar `run`;
5. validar e transformar a saída;
6. emitir o evento de sucesso ou falha e retornar ou lançar.

Um adapter pode decodificar uma requisição antes do pipeline e codificar a
resposta depois dele, mas não pode pular ou reimplementar etapas. A versão 0.1
não terá policies before/after/onError, fila, concorrência, retry ou lifecycle.

Falhas serão `EngineError` com um dos sete códigos estáveis:
`CAPABILITY_NOT_FOUND`, `INPUT_INVALID`, `UNAUTHENTICATED`, `FORBIDDEN`,
`OUTPUT_INVALID`, `CANCELLED` ou `EXECUTION_FAILED`. `publicDetails` e `cause`
serão opcionais; somente `publicDetails` poderá ser serializado por padrão.
Exceções desconhecidas serão normalizadas como `EXECUTION_FAILED`.

O único hook transversal será `onEvent`. Ele receberá somente
`invocation.started`, `invocation.completed` e `invocation.failed`, com os campos
mínimos definidos pelo contrato público. Payloads de negócio, tokens e
credentials não farão parte desses eventos. A engine customizada poderá conectar
o hook a logs, métricas ou tracing.

## Consequências

- Todos os transportes compartilham a mesma semântica de execução.
- Códigos de erro tornam integrações estáveis sem depender de mensagens humanas.
- Logs, métricas e tracing podem observar eventos sem entrar no domínio.
- O pipeline e a ordem de seus estágios passam a ser parte do contrato e precisam
  de testes de contrato.
- Eventos de domínio e garantias de entrega não são oferecidos pelo kernel.
