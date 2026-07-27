---
name: ai-engine-contract-review
description: "Revisar contratos do AI Engine quanto a API pública, critérios de aceite, erros, invariantes, limites operacionais, compatibilidade e fronteiras arquiteturais. Usar antes de implementar ou aprovar mudanças em interfaces, schemas, portas, eventos, persistência observável, configuração e comportamentos públicos deste repositório."
---

# AI Engine Contract Review

## Estabelecer a fonte de verdade

1. Ler `docs/README.md` e o contrato conceitual em `docs/visao-e-invariantes.md`.
2. Confrontar a mudança com `docs/arquitetura.md`, `docs/escopo-v0.1.md`, `docs/plano-e-criterios-de-aceite.md`, `docs/adr/README.md` e os ADRs aplicáveis.
3. Inspecionar tipos públicos, testes de aceitação e implementação existente. Não inferir garantias apenas de exemplos ou detalhes internos.
4. Identificar o consumidor, a superfície pública e o tipo de mudança: aditiva, compatível, ambígua ou quebradora.
5. Permanecer em modo somente leitura quando o pedido for revisar. Editar apenas quando o usuário solicitar correções.

## Cumprir os gates

### Gate 1 — Superfície completa

Inventariar, conforme aplicável:

- operação, entrada, saída e efeitos observáveis;
- erros públicos, códigos, mensagens estáveis e política de retry;
- defaults, configuração, ordenação e determinismo;
- timeout, cancelamento, concorrência e idempotência;
- limites de tamanho, quantidade, profundidade, tempo e recursos;
- versionamento, migração e compatibilidade retroativa;
- porta responsável e adaptador autorizado pelos ADRs.

Marcar explicitamente `não especificado` em vez de preencher lacunas por suposição.

### Gate 2 — Aceite executável

- Reescrever cada requisito como resultado binário e observável quando ele estiver vago.
- Mapear `requisito → contrato → teste de aceitação → evidência`.
- Exigir casos felizes, erros previstos e bordas nos limites inclusivo/exclusivo.
- Rejeitar critérios baseados apenas em estrutura interna, adjetivos subjetivos ou implementação futura não definida.

### Gate 3 — Limites e falhas

- Verificar validação no boundary correto e comportamento consistente entre adaptadores.
- Exigir falha segura e determinística para entrada inválida, excesso de limite, indisponibilidade e cancelamento.
- Procurar recursos sem teto, trabalho duplicado, crescimento não limitado e dependência externa sem timeout.
- Confirmar que logs, métricas e erros não exponham segredo ou conteúdo sensível.

### Gate 4 — Arquitetura e evolução

- Confirmar direção de dependências e responsabilidade de cada porta e adaptador nos ADRs.
- Sinalizar vazamento de tipo de framework, transporte ou persistência para o domínio.
- Separar contrato intencional de detalhe de implementação; impedir que testes públicos cristalizem detalhes internos.
- Classificar quebra de compatibilidade e exigir decisão, versionamento ou migração explícita.

### Gate 5 — Veredito

Emitir `APROVADO` somente quando contrato, aceite e limites estiverem completos, testáveis e coerentes com os ADRs. Emitir `APROVADO COM RESSALVAS` apenas para riscos não bloqueantes com ação concreta. Emitir `BLOQUEADO` para ambiguidade material, quebra não autorizada, ausência de limite crítico ou violação arquitetural.

## Relatar a revisão

Apresentar primeiro os achados, por severidade, com evidência `arquivo:linha`. Em seguida, incluir:

- matriz compacta de rastreabilidade;
- lacunas marcadas como `não especificado`;
- impacto de compatibilidade;
- perguntas que exigem decisão;
- veredito e gates pendentes.

Não declarar ausência de problemas sem registrar as superfícies e os limites verificados.
