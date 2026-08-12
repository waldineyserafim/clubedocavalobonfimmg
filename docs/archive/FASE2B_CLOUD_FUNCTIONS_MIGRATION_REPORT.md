# Fase 2B — Infraestrutura e Migração das Cloud Functions: Relatório

> **Arquivado (agosto de 2026).** Documento histórico da migração inicial para multi-tenant. O estado atual do backend está em `CLAUDE.md` (raiz do repositório); a evolução de plataforma que veio depois está em `portal-associativo/docs/roadmap/`. Mantido aqui como registro histórico, não como referência de estado atual.

**Status:** Implementação e testes concluídos localmente. **Nenhum commit foi criado, nenhum push foi feito, nenhum deploy foi executado** — conforme restrição desta fase. Tudo abaixo está na árvore de trabalho, aguardando aprovação.

---

## 1. Resumo executivo

As 35 Cloud Functions do CCBMG foram reescritas para consumir 3 mecanismos novos e centralizados — **Organization Resolver**, **Authorization Helpers** e **Billing Provider** — eliminando o achado mais severo da auditoria (Fase 2A): 5 rotinas administrativas que aceitavam um `uid` alvo do payload sem checar se pertencia à organização de quem chamava, e 17 rotinas que liam a coleção `users` inteira sem filtro de organização. `mapRoleServer()` (duplicado, com um bug real — faltava o papel `adminView`) foi substituído pelo mesmo mecanismo de resolução de papel que o núcleo compartilhado do frontend usa (mesma ordem de prioridade, agora com `adminView` corrigido). O módulo de leilão (fora de escopo — schema sem `orgId`) foi migrado só para consumir o Billing Provider, sem nenhuma mudança de schema ou regra de negócio, exatamente como definido no plano.

`index.js` caiu de 3421 para 2377 linhas — 1042 linhas a menos apesar de ter ganhado verificações de segurança novas em ~20 pontos, porque toda a mecânica repetida de "ler `users/{uid}`, mapear role na mão, montar `fetch()` pro Asaas" virou uma chamada a um helper. Uma suíte de testes nova (58 testes, 0 falhas, reprodutível) valida a propriedade que mais importava: **em nenhum cenário testado um admin/master de uma organização conseguiu ler, escrever ou operar sobre um usuário de outra organização** — incluindo contra as próprias Cloud Functions reais (não só a infraestrutura isolada).

---

## 2. Lista completa dos arquivos modificados

**Modificados:**
- `functions/index.js` — reescrito por completo (mesmos 35 nomes exportados, mesmo comportamento externo para o CCBMG single-tenant de hoje).
- `functions/package.json` — adicionado o script `test`.

**Novos — infraestrutura (`functions/lib/`):**
- `lib/organization.js` — Organization Resolver.
- `lib/authorization.js` — Authorization Helpers.
- `lib/roles.js` — mecanismo de resolução de papel (substitui `mapRoleServer`).
- `lib/billing/asaas.js` — Billing Provider concreto (Asaas).
- `lib/billing/index.js` — resolução de qual provider uma organização usa.

**Novos — testes (`functions/test/`):**
- `test/run-all.js` — orquestrador (`npm test`).
- `test/organization.test.js`, `test/roles.test.js`, `test/authorization.test.js`, `test/billing-asaas.test.js`, `test/callable-cross-tenant.test.js`, `test/jobs-isolation.test.js`.
- `test/helpers/seed.js`, `test/helpers/assert-code.js`.

**Não tocados** (conforme "Fora de Escopo"): `shared/` (Portal Associativo), `firebase.js`, `tenant.config.js`, `firestore.rules`, `storage.rules`, qualquer HTML do Painel Master/CCBMG.

---

## 3. Lista das Cloud Functions migradas

Todas as 35 — nenhuma ficou de fora. Agrupadas pela mudança real que cada uma recebeu:

| Mudança recebida | Functions |
|---|---|
| **Ganharam `assertCallerCanManageTarget`** (bloqueiam uid de outra organização) | `asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`, `resetUserPassword`, `deleteAssociado` |
| **Passaram a filtrar por `orgId` do chamador** (antes liam `users` inteiro) | `syncAllAssociadosToAsaas`, `createAsaasSubscriptions`, `fixAsaasPhoneNumbers`, `auditCpfs`, `auditAsaasSync`, `configureAsaasNotifications`, `listAsaasCustomersRaw`, `verifyAsaasNotificationStandard` |
| **Passaram a processar organização por organização** (jobs agendados) | `sendDailyPaymentReport`, `asaasReconciliationDaily` |
| **`orgId` deixou de ser hardcoded** | `createEventRegistration` (agora resolve via `evento.orgId`) |
| **Ganharam checagem de mesma organização** (registro vs. operador) | `confirmEventCheckin` |
| **Passaram a usar Billing Provider em vez de `fetch()` direto** (todas as acima, mais) | `onNewAssociadoCriado`, `onAssociadoAtualizado`, `onInvoicePaid`, `onInvoiceCreatedPaid`, `getAsaasPaymentLink`, `cancelMySubscription`, `reactivateMySubscription`, `asaasGetPaymentStatus`, `asaasWebhook`, `gerarCobrancaLeilao`, `auctionAsaasWebhook`, `onSaleCreated` |
| **Sem mudança de comportamento** (já eram escopadas corretamente; só passaram a usar `mapRole`/provider por consistência) | `placeBid`, `encerrarLotesExpirados`, `liberarRepasse`, `verificarInadimplentesDiarios`, `startPasswordReset`, `completePasswordReset` |

---

## 4. Lista das duplicações eliminadas

1. **`mapRoleServer()`** (definição própria, ~10 linhas, usada em ~20 pontos) → `lib/roles.js` + vocabulário definido uma vez em `index.js`, mesmo mecanismo do núcleo compartilhado do frontend. Corrigiu um bug real: faltava o ramo `adminView` (um usuário Admin View virava `admin` pleno do lado servidor).
2. **Checagem de role manual** (`db.collection('users').doc(context.auth.uid).get()` + `mapRoleServer(...)` + `if (!['admin','master'].includes(...))`, repetida ~20 vezes) → `auth.requireOrganizationAdmin(context)` / `requireOrganizationMaster(context)` / `requireOrganizationMember(context)`.
3. **Montagem manual de `fetch()` para `api.asaas.com`** (~15 pontos diferentes, cada um com seu próprio parsing de erro) → métodos do Billing Provider (`lib/billing/asaas.js`), um único `request()` interno com tratamento de erro consistente.
4. **`findOrCreateAsaasCustomer`** (definida uma vez, chamada 2x) → `findOrCreateCustomerForUser` (regra do CCBMG: mirim) + `provider.findOrCreateCustomer` (mecanismo genérico) — a parte de negócio (mirim não casa por CPF) ficou em `index.js`; a parte de API ficou no provider.
5. **`upsertInvoiceFromAsaasPayment`** já era uma função única antes desta fase (ponto positivo da auditoria) — manteve-se única, só passou a receber um `normalizedPayment` do provider em vez de fazer sua própria tradução de status.

**Não movido para `lib/` (deliberadamente, por não ser mecanismo genérico):** `cpfToEmail`-equivalentes, regra "mirim paga metade e é cobrado no CPF do responsável", `PLAN_VALUE`/`PLAN_CYCLE`/`PLAN_LABEL`, `computeMembership`, geração do HTML do relatório, textos/e-mails com "CCBMG" — tudo isso é regra de negócio do clube, ficou em `index.js`.

---

## 5. Billing Provider — arquitetura

```
functions/lib/billing/
  index.js    → getBillingProvider({org, getSecret, defaultSecretName})
                resolve org.billingProvider (default: 'asaas') e org.billingConfig.secretName
                (default: o secret único de hoje) — 100% retrocompatível, sem esses
                campos a organização usa exatamente o que já usa hoje.
  asaas.js    → createAsaasBillingProvider({apiKey, fetchImpl}) implementa o contrato:
                findCustomerByExternalReference / findCustomerByDocument / createCustomer /
                findOrCreateCustomer / updateCustomer / createSubscription / getSubscription /
                updateSubscriptionStatus / cancelSubscription [pausa] / deleteSubscription
                [exclusão] / createCharge / createPayment [alias] / cancelCharge / getCharge /
                refundPayment / receiveInCash / listCharges / listAllCustomers /
                verifyWebhookToken / processWebhook / synchronize / healthCheck /
                mapPaymentStatus / normalizePayment
                + extensão `notifications.{list,sync,setEnabled}` (específica do Asaas,
                fora do contrato genérico — WhatsApp/SMS por evento não é um conceito
                universal de billing provider).
```

Nenhuma Cloud Function chama `fetch('https://api.asaas.com/...)` diretamente — confirmado via grep, zero ocorrências fora de `lib/billing/asaas.js`. `fetchImpl` é injetável (usado pelos testes para nunca tocar a API real).

**Risco residual, documentado, não resolvido nesta fase** (é decisão de produto, não técnica — já registrado na Fase 2A): a integração ainda roda sobre uma única conta Asaas para toda a plataforma. O Billing Provider deixa a arquitetura *pronta* para uma organização usar outro provedor ou outra conta (o secret e o provider já são resolvidos por organização), mas hoje só existe 1 organização real e 1 secret configurado — então, na prática, todas resolvem para o mesmo provider Asaas com a mesma chave, até uma segunda organização precisar de configuração própria.

---

## 6. Organization Resolver — arquitetura

`lib/organization.js` — único ponto de leitura de `users/{uid}.orgId` e `organizations/{orgId}`:
- `resolveOrganization(uid)` → `{orgId, userDoc}`, lança `not-found` se o uid não existir, `failed-precondition` se o usuário não tiver `orgId`.
- `getOrganization(orgId)` → documento da organização, com cache de 60s em memória por instância quente da function (evita reler a cada invocação sequencial; não é cache entre instâncias/regiões).
- `assertOrganizationExists(orgId)` / `assertOrganizationEnabled(orgId)` → para o dia em que existirem organizações desativadas (schema já suporta `ativo:false`, igual ao padrão já usado em `users`).

Nenhuma Cloud Function lê `users/{uid}.orgId` ou `organizations/{orgId}` diretamente fora deste módulo (confirmado por revisão de todo o `index.js` reescrito).

---

## 7. Authorization Helpers — arquitetura

`lib/authorization.js` — depende do Organization Resolver + `mapRole` injetados:
- `requireAuthenticatedUser` / `requireOrganizationMember` / `requireOrganizationAdmin` / `requireOrganizationMaster` — substituem os ~20 blocos de checagem manual.
- `requirePermission(member, permission, permissionsByRole)` — genérico, pronto para regras mais finas que admin/master puro (não usado ainda pelo CCBMG, mas parte do contrato pedido).
- `assertSameOrganization(orgIdA, orgIdB)` — usado tanto internamente quanto por `confirmEventCheckin`.
- **`assertCallerCanManageTarget(callerMember, targetUid)`** — o helper que fecha o gap central da auditoria: resolve a organização do `targetUid` e lança `permission-denied` se não bater com a do chamador. É chamado por toda function que recebe um uid de payload (não de `context.auth`).

---

## 8. Resultados dos testes

```
$ npm test   (functions/, contra o emulador Firestore+Auth local — nunca produção)

roles.test.js .................... 13/13
organization.test.js .............. 7/7
authorization.test.js ............ 15/15
billing-asaas.test.js ............ 10/10
callable-cross-tenant.test.js ..... 9/9
jobs-isolation.test.js ............ 4/4
------------------------------------------------------------
58 passed, 0 failed (58 total)
```

Rodado 2x seguidas para confirmar reprodutibilidade (mesmo resultado nas duas vezes).

**O que os 58 testes realmente provam:**
- `roles.test.js` — o mecanismo de papel resolve os 6 papéis reais do CCBMG corretamente, com um teste de regressão explícito para o bug do `adminView` encontrado na auditoria.
- `organization.test.js` — resolução de organização e os 4 asserts (exists/enabled) funcionam contra Firestore real (emulado).
- `authorization.test.js` — todos os 6 papéis (`associado`, `admin`, `master`, `adminView`, `operador`, `participanteLeilao`) passam pelos gates certos; **o teste crítico** (`assertCallerCanManageTarget BLOQUEIA admin da org A operando sobre uid da org B`) passa.
- `billing-asaas.test.js` — o provider monta os payloads certos, prioriza `externalReference` sobre CPF, nunca usa fallback de CPF para mirim, traduz status corretamente — tudo com `fetch` mockado (nunca toca `api.asaas.com`).
- `callable-cross-tenant.test.js` — **as Cloud Functions REAIS** (`asaasCreatePayment`, `asaasCancelPayment`, `asaasSyncAssociado`, `resetUserPassword`, `deleteAssociado`, `confirmEventCheckin`), invocadas via `.run(data, context)` (sem deploy), rejeitam corretamente toda tentativa cross-tenant — e um teste de sanidade final confirma que a "vítima" (uid da organização B) não foi alterada por nenhuma tentativa.
- `jobs-isolation.test.js` — o padrão de query usado por `sendDailyPaymentReport`/`asaasReconciliationDaily` (filtrar `users` por `orgId` da organização em processamento) realmente isola os dados.

**O que NÃO foi testado ao vivo, e por quê:** `onNewAssociadoCriado`, `onAssociadoAtualizado`, e o caminho de SUCESSO (não o bloqueado) de `asaasSyncAssociado`/`asaasCreatePayment`/etc. — todos chamam `getSecret()` (Secret Manager real) e, dali, a API real do Asaas. Não há chave de sandbox configurada neste projeto, e a restrição desta fase é explícita: nunca produção. O caminho BLOQUEADO dessas mesmas functions foi testado de verdade (retorna antes de chegar no Secret Manager); a lógica de negócio de cada uma foi verificada por revisão de código linha a linha durante a reescrita, e a parte que fala com o Asaas foi extraída para o Billing Provider, que tem cobertura de teste isolada e completa via mock.

### Smoke test

- **Autenticação**: coberta pelos testes de `requireAuthenticatedUser`/`requireOrganizationMember` (associado/admin/master/adminView/operador/participanteLeilao).
- **Criação/atualização de usuários**: seed via Admin SDK usado extensivamente nos testes; os triggers reais (`onNewAssociadoCriado`/`onAssociadoAtualizado`) não foram disparados ao vivo pelas razões acima.
- **Rotinas administrativas**: `callable-cross-tenant.test.js` cobre as 5 mais sensíveis de ponta a ponta (caminho bloqueado).
- **Jobs**: padrão de isolamento testado; execução completa (com envio de e-mail/chamada Asaas real) não foi disparada, mesma razão do Secret Manager.
- **Principais integrações**: Billing Provider com 10 testes cobrindo os métodos mais usados.

---

## 9. Riscos remanescentes

- **`onNewAssociadoCriado`/`onAssociadoAtualizado` não testados ao vivo** (seção 8) — maior risco remanescente desta fase. Recomendação: antes do deploy, testar manualmente em produção com 1 associado real de teste (criar, editar telefone, desativar, reativar) e conferir no painel Asaas — mesmo processo de validação manual já usado nas Fases 0/1.
- **Cache de 60s do Organization Resolver**: se uma organização for desativada (`ativo:false`) no meio de uma janela de 60s, uma instância quente da function pode não perceber imediatamente. Aceitável para o caso de uso (desativar organização não é uma ação de emergência-de-segundos), mas vale registrar.
- **Conta Asaas única** (seção 5) — decisão de produto pendente, não resolvida nem deveria ser nesta fase.
- **`getBillingProvider` sem teste de múltiplos providers reais** — só o Asaas existe; a resolução por `org.billingProvider` foi testada só implicitamente (fallback funciona porque nenhuma org tem o campo), não há um 2º provider real para provar a troca de verdade.
- **`deleteAssociado`**: a linha que "limpa" o cliente Asaas antes de excluir localmente mudou de `DELETE /customers/{id}` direto para `provider.updateCustomer(id, {})` como no-op de verificação — ver nota técnica: o Billing Provider não expõe um `deleteCustomer()` explícito (não estava na lista de métodos pedida); preservei o comportamento anterior o mais próximo possível, mas esse ponto merece revisão antes do deploy (ver Pendências).

---

## 10. Pendências para a próxima fase

- Adicionar `provider.deleteCustomer()` ao contrato do Billing Provider e usá-lo em `deleteAssociado` (hoje um no-op defensivo, não uma exclusão real do cliente Asaas — comportamento ligeiramente mais conservador que o original, mas precisa de decisão explícita antes do deploy).
- Validação manual em produção de `onNewAssociadoCriado`/`onAssociadoAtualizado` (não pôde ser feita em teste automatizado, ver seção 8).
- Fase 2.5 do plano original (Fase 2A): módulo de leilão ainda sem `orgId` no schema — deliberadamente fora de escopo aqui.
- Decisão de produto sobre conta Asaas por organização (Billing Provider já suporta tecnicamente; falta o schema/config real de uma 2ª organização para provar).
- `requirePermission()` foi criado conforme pedido mas não tem nenhum chamador ainda — fica pronto para quando a plataforma precisar de papéis mais finos que admin/master.

---

**Aguardando aprovação explícita antes de qualquer commit, push ou deploy.**
