# Fase 2C — Finalização da Arquitetura SaaS Multi-Tenant: Relatório

> **Arquivado (agosto de 2026).** Documento histórico — fechamento dos gaps do módulo de leilão e do Billing Provider extensível, anteriores à camada de plataforma (Painel Master, `platformAdmins`, provisionamento) construída a partir da Fase 3.1. Estado atual em `CLAUDE.md` (raiz do repositório) e `portal-associativo/docs/roadmap/`. Mantido aqui como registro histórico, não como referência de estado atual.

**Status:** Implementação e testes concluídos localmente. **Nenhum commit foi criado, nenhum push foi feito, nenhum deploy foi executado.** Tudo abaixo está na árvore de trabalho (junto com a Fase 2B, que também nunca foi commitada), aguardando aprovação.

---

## 1. Resumo executivo

Esta fase fechou as pendências deixadas pela Fase 2B e resolveu o item de maior escopo do roadmap: o módulo de leilão. O achado mais importante não estava na lista de tarefas original — foi descoberto investigando **por que** o schema precisava de `orgId`: o frontend (`lote_form.html`, `admin_leiloes.html`) já vinha gravando e consultando `auctionLots`/`auctionSales` filtrados por `orgId` **desde junho/2026** (commit `97a498ab`), e os índices compostos necessários (`auctionLots(orgId,...)`, `auctionSales(orgId,...)`) **já existiam** em `firestore.indexes.json`. Ou seja: alguém começou a migração do módulo de leilão pelo lado do frontend e nunca terminou o backend — as Cloud Functions nunca escreviam `orgId` em `auctionSales`/`auctionPayments`, e as Firestore Rules nunca validavam organização. Na prática, `admin_leiloes.html:605` (`where("orgId","==",currentOrgId)` em `auctionSales`) provavelmente já retornava resultados incompletos em produção, silenciosamente.

Esta fase: (1) completou o Billing Provider com `deleteCustomer()`; (2) fechou esse gap do leilão de ponta a ponta — schema, Cloud Functions, Firestore Rules, índice novo e uma function de backfill; (3) preparou o Billing Provider para múltiplos providers via um registro extensível; (4) encontrou e corrigiu, durante a revisão de todas as coleções (item explicitamente pedido), o mesmo padrão de gap em **`memberClassifieds`** (tinha `orgId` no schema, mas Rules não validavam) — não estava na lista de escopo original, mas a própria fase exige "nenhuma coleção incompatível com Multi-Tenant" como critério de aceite; (5) removeu `canOperate()` de `firestore.rules`, que ficou órfã depois dessas correções; (6) descobriu e corrigiu 11 testes e2e do frontend que já estavam quebrados desde a Fase 2B (nunca rodei a suíte Playwright naquela fase — só a suíte nova de `functions/test`) — checavam padrões de código exatos que a extração do Billing Provider mudou.

---

## 2. Lista completa dos arquivos modificados

**Modificados nesta fase** (além do que a Fase 2B já tinha deixado sem commit):
- `functions/index.js` — `deleteAssociado` usa `deleteCustomer()`; módulo de leilão inteiro (7 functions) ganhou `orgId`/autorização; nova function `backfillLeilaoOrgId`.
- `functions/lib/billing/asaas.js` — `deleteCustomer()`.
- `functions/lib/billing/index.js` — registro de providers extensível (`registerBillingProvider`).
- `firestore.rules` — `auctionLots`/`auctionLots/bids`/`auctionSales`/`auctionPayments` com checagem de organização; `memberClassifieds`/`classificados` idem; `canOperate()` removida (dead code).
- `firestore.indexes.json` — 1 índice novo: `auctionPayments(orgId, status, dueDate)`.
- `tests/e2e/08-asaas-firebase-integration.spec.js` — 3 testes atualizados (checavam `functions/index.js`, agora checam `functions/lib/billing/asaas.js`).
- `tests/e2e/11-central-financeira-asaas.spec.js` — 8 testes atualizados (assinaturas de função e padrões de autorização mudaram na Fase 2B).

**Novos:**
- `docs/FASE2C_MULTI_TENANT_FINALIZATION_REPORT.md` (este arquivo).
- `functions/test/auction-isolation.test.js`, `functions/test/billing-registry.test.js`.

**Não tocados** (fora de escopo, conforme pedido): Shared/Core, frontend (nenhum `.html`), `firebase.js`, `tenant.config.js`, Painel Master, Branding, hospedagem multi-domínio.

---

## 3. Mudanças de schema

| Coleção | Mudança | Quem grava agora |
|---|---|---|
| `auctionSales` | ganha `orgId` (herdado do lote) | `encerrarLotesExpirados` (Cloud Function) |
| `auctionPayments` | ganha `orgId` (herdado da venda) | `gerarCobrancaLeilao`, `auctionAsaasWebhook` |
| `auctionNotifications` | ganha `orgId` (herdado do lote/venda) | `encerrarLotesExpirados`, `liberarRepasse`, `verificarInadimplentesDiarios` |
| `auctionLots` | nenhuma — já tinha `orgId` desde jun/2026 (frontend) | `lote_form.html` (inalterado) |
| `auctionLots/{id}/bids` | nenhuma — continua sem `orgId` próprio, herda do lote pai via `sameOrgAsLot()` nas Rules | — |

Todos os campos novos são **opcionais/aditivos** — nenhum documento existente perde compatibilidade; o que muda é que documentos **novos** passam a ter o campo, e as Rules passam a exigi-lo para acesso administrativo cross-check (não para o dono/parte da transação, que continuam funcionando por uid, com ou sem `orgId`).

`memberClassifieds`/`classificados`: nenhuma mudança de schema (já tinham `orgId` desde antes) — só as Firestore Rules foram corrigidas para validar.

---

## 4. Backfill

Criada `exports.backfillLeilaoOrgId` (callable, master only) — preenche `orgId` em documentos de `auctionLots`/`auctionSales`/`auctionPayments`/`auctionNotifications` que não têm o campo, sem nunca sobrescrever quem já tem. Testada no emulador (`auction-isolation.test.js`): confirma que preenche o que falta e nunca toca no que já está correto.

**Não executada em produção por mim** — é uma ação write, uso pontual, e a instrução desta fase foi "não usar produção para testes automatizados"; rodar o backfill de verdade é uma ação de escrita em produção, não um teste. Recomendo rodá-la manualmente (via console do Firebase ou uma chamada autenticada como master) logo após o deploy desta fase — o número de documentos afetados hoje é pequeno (é um clube só, poucos leilões).

---

## 5. Revisão de todas as coleções (item de escopo 5)

| Coleção | orgId? | Rules multi-tenant? | Status |
|---|---|---|---|
| `users` | ✓ | ✓ (G3, Fase 0) | Compatível |
| `users/*/finance`, `/financeInvoices` | escopado pelo uid pai | ✓ (G3) | Compatível |
| `organizations/{orgId}` | é a própria chave | ✓ | Compatível por definição |
| `organizationSubscriptions` | ✓ (confirmado: `admin_master_faturamento.html` faz `orderBy("orgId")`) | master-only, sem checagem de org — **correto por design**: é billing da organização PARA a plataforma, não dado da organização em si; master é cross-org por natureza aqui | Compatível |
| `systemConfig/global` | N/A (doc único, config global da plataforma) | master-only | Compatível por design |
| `systemPlans` | N/A (catálogo público de planos, igual pra todo mundo) | leitura por qualquer logado, escrita master | Compatível por design |
| `systemLogs` | ✓ (gravado por `shared/core/tenant/audit.js`, Fase 0) | leitura master-only (sem admin cross-org, então sem gap) | Compatível |
| `cms_banners/board/events/gallery/partners/about` | ✓ | ✓ (G3, Fase 0) | Compatível |
| `memberServices/memberProducts` | ✓ | ✓ (G3, Fase 0) | Compatível |
| `memberClassifieds` | ✓ (já existia) | **Corrigido nesta fase** (era `canOperate()` sem org) | Compatível agora |
| `classificados` | não (legado, confirmado sem nenhum escritor hoje) | Corrigido por consistência (mesmo padrão), mas coleção efetivamente morta | Compatível, uso residual nulo |
| `eventRegistrations` | ✓ (Fase 1) | ✓ | Compatível |
| `passwordResetAttempts` | não — rate-limit por CPF, cross-org por design (não é dado de negócio) | N/A | Compatível por design |
| `auctionLots`, `auctionLots/bids` | ✓ (lots já tinha; bids herda) | **Corrigido nesta fase** | Compatível agora |
| `auctionSales`, `auctionPayments`, `auctionNotifications` | ✓ **novo nesta fase** | **Corrigido nesta fase** | Compatível agora (após backfill) |

**Conclusão do item 5: depois desta fase, não resta nenhuma coleção de dado de tenant sem isolamento por organização.** As únicas coleções sem `orgId` (`organizationSubscriptions`, `systemConfig`, `systemPlans`, `passwordResetAttempts`) são, por natureza, dado da plataforma ou cross-tenant por design — não dado de uma organização específica — não é uma lacuna, é a categoria certa de dado para não ter `orgId`.

---

## 6. Auditoria final (item de escopo 6)

**Existe qualquer ponto restante que ainda assuma um único tenant?**
Sim, dois, ambos já documentados como decisão de produto (não bug):
1. Webhooks do Asaas (`asaasWebhook`, `auctionAsaasWebhook`) usam `getDefaultProvider()` para a verificação anti-fraude inicial, porque o Asaas manda o webhook pra 1 conta/token só — antes de saber a qual organização o pagamento pertence, não há como rotear. Depois de resolver o uid/saleId, o restante do fluxo já usa o provider certo da organização.
2. `checkAndIncrementResetAttempts` (rate-limit de reset de senha) é global por CPF, não por organização — decisão correta (é proteção contra abuso, não dado de negócio).

**Existe qualquer leitura cruzada possível?** Não identificada, com uma ressalva: `startPasswordReset`/`completePasswordReset` buscam por CPF sem `orgId` obrigatório (aceitam um `orgId` opcional no payload, adicionado na Fase 2B) — se a mesma pessoa física fosse associada em duas organizações da plataforma com o mesmo CPF (hoje impossível de testar, só existe 1 organização), a busca sem `orgId` pegaria a primeira que aparecesse. Risco teórico, registrado, não corrigido nesta fase (exigiria o cliente sempre mandar `orgId`, o que depende do fluxo de login saber a organização antes do CPF ser validado — mudança de UX, fora do escopo de Functions).

**Existe qualquer escrita cruzada possível?** Não identificada nos testes realizados (73 testes de `functions/test` + 11 novos desta fase, incluindo os testes críticos de `placeBid`/`gerarCobrancaLeilao`/`liberarRepasse` cross-tenant).

**Existe qualquer integração acoplada?** Sim, uma, já registrada como decisão de produto pendente desde a Fase 2A: conta Asaas única para toda a plataforma. O Billing Provider (e agora o registro extensível) deixam a arquitetura pronta para mudar isso; a mudança em si depende de decisão de negócio, não de código.

**Existe qualquer duplicação remanescente?** Não encontrada. Confirmado via grep: zero `fetch()` direto ao Asaas fora de `lib/billing/`; zero `db.collection('users').get()` sem filtro de organização; zero checagem de role manual duplicada fora dos 2 usos legítimos em `auditCpfs`/`auditAsaasSync` (que mapeiam o papel de CADA usuário listado, não fazem autocheck do chamador — isso já usa `auth.requireOrganizationAdmin`).

---

## 7. Resultados dos testes

**`functions/test` (emulador, nunca produção):** 73 testes, 0 falhas (eram 58 na Fase 2B; 15 novos nesta fase: `deleteCustomer` (+1 em `billing-asaas.test.js`), registro de provider (+5 em `billing-registry.test.js`, arquivo novo), isolamento de leilão + backfill (+9 em `auction-isolation.test.js`, arquivo novo) — 58+1+5+9=73). Rodado 2x seguidas, mesmo resultado.

**`npm run test:e2e` (Playwright, frontend, 2 projetos):** 1259 passed, 85 failed (todas as 85 pré-existentes desde a Fase 1 — string `bootstrap@5.3.3` desatualizada + 2 checagens contra dado real de produção — mais 1 teste flaky que passou no retry). **Zero falhas novas** — verificado por comparação categoria a categoria com o padrão já estabelecido, não só pela contagem total. Encontrei e corrigi, durante essa verificação, 11 testes que já estavam quebrados desde a Fase 2B (nunca rodei esta suíte naquela fase) — ver seção 1.

**Firestore Rules:** `firebase deploy --only firestore:rules --dry-run` compila sem erros e sem warnings (o warning de `canOperate()` não utilizada, que apareceu no meio do processo, foi resolvido removendo a função morta).

---

## 8. Riscos remanescentes

- **Backfill não executado em produção** (seção 4) — é o único passo desta fase que precisa de uma ação manual pós-deploy.
- **Busca por CPF sem `orgId` obrigatório** em `startPasswordReset`/`completePasswordReset` (seção 6) — risco teórico, hoje intestável (só 1 organização existe), registrado para quando houver uma 2ª.
- **Conta Asaas única** — decisão de produto pendente, não técnica; o Billing Provider já está pronto para quando for resolvida.
- **`gerarCobrancaLeilao`/`liberarRepasse`** aceitam vendas sem `orgId` (pré-Fase 2C) com uma regra especial ("só master decide") até o backfill rodar — comportamento transitório e intencional, mas só se aplica antes do backfill.
- Como nas fases anteriores: nada foi commitado — o raio de mudança acumulado (Fase 2B + 2C) num commit só é grande; ao aprovar, vale considerar 2 commits separados (2B e 2C) para manter o histórico legível e o rollback mais granular, mas a decisão é sua.

---

## 9. Pendências para além desta fase

- Rodar `backfillLeilaoOrgId` manualmente em produção após o deploy.
- Decisão de produto: conta Asaas por organização (habilitada pela arquitetura, não implementada).
- G4 (hospedagem multi-domínio), migração real do Painel Master, Branding/White Label — inalterados, seguem como já registrado desde as Fases 0/1.
- Validação manual em produção dos triggers `onNewAssociadoCriado`/`onAssociadoAtualizado` (pendência já registrada desde a Fase 2B — continua sem poder ser testada automaticamente, mesma razão: precisam de Secret Manager real).
- Considerar adicionar `orgId` obrigatório (não mais opcional) em `startPasswordReset`/`completePasswordReset` quando houver uma 2ª organização real para validar o fluxo de UX correspondente.

---

**Aguardando aprovação explícita antes de qualquer commit, push ou deploy.**
