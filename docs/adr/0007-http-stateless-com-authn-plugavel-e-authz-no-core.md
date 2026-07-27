# ADR 0007: HTTP stateless, autenticação plugável e autorização no core

- Status: Accepted
- Data: 2026-07-27

## Contexto

Implantações HTTP podem autenticar com JWT, API key, proxy de identidade ou outro
mecanismo. Essas opções pertencem à borda e variam por ambiente. Já a autorização
de uma operação é regra do engine e precisa valer igualmente para outros
transportes.

## Decisão

A integração HTTP será stateless: cada requisição conterá tudo que for necessário
para autenticá-la e executá-la. O adaptador padrão não manterá sessão de usuário,
cookie de sessão, afinidade com instância nem identidade em estado global.

Autenticação (`authn`) será uma porta plugável da borda HTTP. O autenticador
receberá os dados do transporte e produzirá um principal normalizado e limitado
ao contexto da requisição, ou rejeitará a requisição. Tokens, headers e tipos de
framework não atravessarão para o domínio.

Autorização (`authz`) será responsabilidade do `@ai-engine/core` e ocorrerá no
pipeline de `invoke`, antes do handler. A operação declarará se é pública ou quais
políticas exige. Operações protegidas falharão de modo fechado quando não houver
principal ou decisão de autorização válida. Adaptadores apenas mapearão o erro
estruturado; não poderão liberar acesso nem duplicar políticas de negócio.

Depois da autenticação, o adaptador HTTP construirá a invocação e chamará
`invoke`; não chamará handlers diretamente.

## Consequências

- Estratégias de identidade podem variar sem modificar operações do core.
- Escala horizontal não depende de sessão mantida por uma instância.
- A mesma política de autorização vale para HTTP e outros transportes.
- Recursos que precisem de sessão deverão usar estado externo explícito e não
  alterar a semântica stateless do adaptador.
- Testes precisam cobrir autenticadores plugáveis, isolamento por requisição,
  falha fechada e execução negada antes do handler.
