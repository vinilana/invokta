# ADR 0005: CLI executa operações sempre via `invoke`

- Status: Accepted
- Data: 2026-07-27

## Contexto

Uma CLI que chama handlers diretamente cria um segundo caminho de execução e pode
contornar validação, autorização, eventos e normalização de erros. Isso faria o
comportamento de uma operação depender da forma como ela foi chamada.

## Decisão

Todo comando da `@ai-engine/cli` que execute uma operação do engine deverá montar
a invocação e chamar a API pública `invoke` do `@ai-engine/core`. A CLI não poderá
importar handlers para executá-los, reproduzir o pipeline ou aplicar regras de
negócio antes ou depois de `invoke`.

À CLI caberá somente:

- interpretar argumentos e entrada padrão;
- selecionar a operação e construir seu contexto de transporte;
- chamar `invoke` uma vez;
- formatar o resultado ou erro estruturado;
- escolher o exit code a partir da categoria ou do código de erro documentado.

Ajuda, versão e erros puramente sintáticos da própria linha de comando não são
operações do engine e podem ser resolvidos localmente. Assim que uma operação for
selecionada, seu único caminho de execução será `invoke`.

## Consequências

- CLI, MCP, HTTP e uso programático exercitam as mesmas garantias.
- Testes da CLI podem se concentrar em parsing, formatação e integração com
  `invoke`.
- Recursos exclusivos da CLI não podem existir como atalhos para handlers; devem
  ser modelados como operações quando pertencerem ao engine.
- O mapeamento de erros para exit codes precisa ser estável e documentado.
