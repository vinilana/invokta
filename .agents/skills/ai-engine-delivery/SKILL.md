---
name: ai-engine-delivery
description: "Implementar marcos e entregáveis do AI Engine com TDD, aderência aos contratos e à arquitetura versionada, validação completa e um commit coeso por entregável. Usar ao desenvolver features, corrigir bugs, executar marcos do roadmap ou concluir critérios de aceite neste repositório."
---

# AI Engine Delivery

## Preparar a entrega

1. Ler `docs/README.md` e localizar o marco em `docs/plano-e-criterios-de-aceite.md`.
2. Confrontar o marco com `docs/arquitetura.md`, `docs/adr/README.md`, os ADRs aplicáveis, os contratos públicos e os testes de aceitação. Tratar essas fontes versionadas como normativas; não reproduzir a especificação nesta skill.
3. Inspecionar o código, os testes e o estado do Git antes de editar. Preservar mudanças alheias e excluir arquivos não relacionados do entregável.
4. Delimitar uma fatia vertical pequena: comportamento observável, critério de aceite, componentes afetados e comando de validação.

Interromper e pedir decisão quando documentos autoritativos se contradisserem, o aceite não for testável ou a implementação exigir ampliar o contrato ou a arquitetura.

## Cumprir os gates

### Gate 1 — Escopo e contrato

- Mapear cada critério de aceite para pelo menos um teste observável.
- Confirmar entradas, saídas, erros, invariantes e limites antes de alterar a implementação.
- Manter compatibilidade com contratos públicos; exigir decisão explícita para qualquer quebra.
- Aplicar `$ai-engine-contract-review` antes do código quando o marco criar ou mudar API, schema, porta, evento, erro público ou limite operacional.

### Gate 2 — RED

- Escrever primeiro o menor teste que demonstre o comportamento ausente ou o bug.
- Executar o teste e confirmar falha pelo motivo esperado, não por erro de ambiente, fixture ou sintaxe.
- Registrar a evidência RED no resumo da entrega.

Não avançar sem um RED válido, salvo mudança estritamente documental ou de ferramenta que não possua comportamento executável. Explicar a exceção.

### Gate 3 — GREEN e REFACTOR

- Implementar apenas o necessário para satisfazer o teste e o contrato.
- Respeitar a direção de dependências, as portas, os adaptadores e as fronteiras definidas nos ADRs.
- Evitar atalhos arquiteturais, dependências globais, bypass de validação e abstrações antecipadas.
- Executar o teste focal até ficar verde; então refatorar sem mudar o comportamento e executá-lo novamente.

### Gate 4 — Validação

- Executar os comandos canônicos documentados no repositório para testes focais, suíte completa, análise estática, formatação e build.
- Adicionar testes de regressão para erros, limites e casos de borda relevantes ao contrato.
- Inspecionar o diff final e comprovar a rastreabilidade `aceite → teste → implementação`.
- Não declarar sucesso com gate obrigatório falhando. Informar bloqueio externo com comando e erro exatos.

### Gate 5 — Commit por entregável

- Incluir somente a fatia validada e seus testes no commit.
- Revisar o diff staged e excluir artefatos gerados, segredos e mudanças não relacionadas.
- Criar um commit coeso após todos os gates passarem; usar mensagem que descreva o comportamento entregue.
- Iniciar o próximo entregável somente depois de fechar o anterior. Não reescrever nem agrupar commits de outros autores.

## Entregar o relatório

Informar:

- entregável e critérios atendidos;
- testes adicionados e evidência RED/GREEN;
- comandos executados e resultados;
- decisões arquiteturais aplicadas;
- hash e mensagem do commit;
- riscos, pendências ou gates não executados.
