# ADR 0008: TDD e commits delimitados por entregável

- Status: Accepted
- Data: 2026-07-27

## Contexto

O projeto define contratos compartilhados por três packages e por vários
transportes. Implementações grandes sem checkpoints verificáveis dificultam
revisão, regressão e bisect. Separar testes da mudança que eles especificam também
reduz a confiabilidade do histórico.

## Decisão

O desenvolvimento seguirá TDD por entregável observável:

1. registrar o comportamento esperado em um teste que falha pelo motivo correto;
2. implementar a menor mudança que faz o teste passar;
3. refatorar mantendo a suíte verde;
4. executar testes, typecheck e lint afetados antes de concluir o entregável.

Correções de bugs começarão por um teste de regressão. Contratos públicos terão
testes de contrato no core e, quando aplicável, nos adaptadores. Dublês poderão
substituir portas, mas os caminhos CLI, MCP e HTTP também terão testes que provem
que convergem para `invoke`.

Cada entregável concluído terminará em um commit próprio, revisável e verde. O
commit incluirá juntos teste, implementação e documentação necessários ao mesmo
comportamento; não misturará refatorações ou funcionalidades alheias. Um
entregável posterior não será acumulado no mesmo commit. Ajustes pedidos em
revisão poderão ser commits adicionais, desde que focados e verdes.

Commits intermediários quebrados podem existir apenas localmente durante o ciclo
red/green; não serão apresentados como entregáveis concluídos.

## Consequências

- Cada decisão implementada possui evidência executável no mesmo recorte de
  histórico.
- Revisão, reversão e `git bisect` ficam mais previsíveis.
- Mudanças transversais precisam ser divididas em fatias verticais pequenas.
- O tempo de feedback depende de comandos de qualidade rápidos e determinísticos.
- Exceções ao ciclo ou ao recorte de commits devem ser justificadas na revisão.
