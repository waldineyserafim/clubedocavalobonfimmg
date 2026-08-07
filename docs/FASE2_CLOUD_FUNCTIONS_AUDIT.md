# Fase 2 — Auditoria de Cloud Functions e Plano de Migração Multi-Tenant

**Status:** Auditoria concluída. Nenhum código foi alterado, nenhum commit foi criado, nada foi publicado — conforme restrição desta fase.
**Escopo analisado:** `functions/index.js` (arquivo único, 3421 linhas, 35 Cloud Functions exportadas + 27 funções auxiliares internas). Não há outros arquivos de functions no projeto (confirmado: `functions/` só contém `index.js`, `package.json`, `package-lock.json`, `node_modules/`).
**Runtime:** Node.js 22, `firebase-functions@^4.9.0` (API de 1ª geração — `functions.https.onCall`/`onRequest`, `functions.firestore.document().onCreate/onUpdate`, `functions.pubsub.schedule`), `firebase-admin@^12.7.0`.

Nota de organização: em vez de repetir as mesmas 10 perguntas da auditoria arquitetural 35 vezes (a maioria das respostas seria idêntica e repetitiva — "lê `users`, sem filtro `orgId`, sim há risco"), os achados estão agrupados por **padrão** nas seções 4–9, e o **Inventário** (seção 1) traz, por function, as respostas específicas que variam. Isso cobre literalmente todas as perguntas pedidas, só organizadas para serem úteis em vez de mecânicas. Se ainda assim quiser o Q&A completo função-a-função, posso gerar como anexo.

---

## 1. Inventário completo

Legenda de colunas: **Trigger** = tipo; **Auth** = quem pode chamar; **orgId?** = a function verifica/filtra por organização; **Asaas** = usa a API do Asaas; **Coleções** = as que lê e/ou escreve.

| # | Function | Trigger | Auth exigida | orgId? | Asaas | Coleções (R=lê, W=escreve) |
|---|---|---|---|---|---|---|
| 1 | `sendDailyPaymentReport` | Scheduled `0 8 * * *` | — (sistema) | **Não** — lê TODOS os `users` | Não (usa e-mail, não Asaas) | R: `users`, `users/*/financeInvoices`, `users/*/finance/summary` |
| 2 | `syncAllAssociadosToAsaas` | Callable | admin/master (role only) | **Não** — TODOS os `users` | Sim | R/W: `users` |
| 3 | `onNewAssociadoCriado` | Trigger `users/{uid}` onCreate | — (sistema) | Não (mas escopado ao doc que disparou) | Sim | R/W: `users/{uid}` |
| 4 | `createAsaasSubscriptions` | Callable | admin/master (role only) | **Não** — TODOS os `users` | Sim | R: `users`, `users/*/financeInvoices`; W: `users` |
| 5 | `configureAsaasNotifications` | Callable | admin/master (role only) | **Não** — TODOS os clientes Asaas (nem passa pelo Firestore) | Sim | — |
| 6 | `listAsaasCustomersRaw` | Callable (diagnóstico) | admin/master (role only) | **Não** — TODOS os clientes Asaas | Sim (leitura) | — |
| 7 | `verifyAsaasNotificationStandard` | Callable (auditoria) | admin/master (role only) | **Não** — TODOS os clientes Asaas | Sim (leitura) | — |
| 8 | `fixAsaasPhoneNumbers` | Callable (migração pontual) | admin/master (role only) | **Não** — TODOS os `users` | Sim | R: `users` |
| 9 | `onAssociadoAtualizado` | Trigger `users/{uid}` onUpdate | — (sistema) | Não (escopado ao doc) | Sim | R/W: `users/{uid}` |
| 10 | `onInvoicePaid` | Trigger `users/{uid}/financeInvoices/{id}` onUpdate | — (sistema) | Não (escopado ao doc) | Sim | R: `users/{uid}`; W: `users/{uid}/financeInvoices` |
| 11 | `onInvoiceCreatedPaid` | Trigger `users/{uid}/financeInvoices/{id}` onCreate | — (sistema) | Não (escopado ao doc) | Sim | idem #10 |
| 12 | `getAsaasPaymentLink` | Callable | usuário autenticado (self) | Implícito via `context.auth.uid` | Sim (leitura) | R: `users/{uid}` |
| 13 | `cancelMySubscription` | Callable | usuário autenticado (self) | Implícito via `context.auth.uid` | Sim | R/W: `users/{uid}` |
| 14 | `reactivateMySubscription` | Callable | usuário autenticado (self) | Implícito via `context.auth.uid` | Sim | R/W: `users/{uid}` |
| 15 | `asaasSyncAssociado` | Callable | admin/master (role only) | **Não** — `uid` vem do payload, sem checar org do alvo | Sim | R/W: `users/{uid}`, `users/{uid}/finance/summary` |
| 16 | `asaasCreatePayment` | Callable | admin/master (role only) | **Não** — `uid` vem do payload, sem checar org do alvo | Sim | R: `users/{uid}` |
| 17 | `asaasCancelPayment` | Callable | admin/master (role only) | **Não** — `uid` vem do payload, sem checar org do alvo | Sim | R/W: `users/{uid}/financeInvoices` |
| 18 | `asaasGetPaymentStatus` | Callable (leitura) | admin/master (role only) | **Não**, mas só leitura por `asaasPaymentId` | Sim (leitura) | — |
| 19 | `asaasReconciliationDaily` | Scheduled `0 4 * * *` | — (sistema) | **Não** — TODOS os `users` | Sim | R/W: `users`, `users/*/finance/summary` |
| 20 | `asaasWebhook` | HTTP público | Token Asaas (`asaas-access-token`) | Não (mas resolve `uid` certo via `externalReference`) | Sim | R/W: `users/{uid}`, `users/{uid}/financeInvoices` |
| 21 | `resetUserPassword` | Callable | master (role only) | **Não** — `targetUid` sem checar org | — | R/W: `users/{targetUid}` + Auth |
| 22 | `startPasswordReset` | Callable | — (público, pré-login) | **Não** — busca por `cpf` sem filtrar `orgId` | — | R: `users` (query por CPF) |
| 23 | `completePasswordReset` | Callable | sessão de telefone verificado | **Não** — busca por `cpf` sem filtrar `orgId` | — | R/W: `users` + Auth |
| 24 | `deleteAssociado` | Callable | master (role only) | **Não** — `uid` sem checar org | Sim | R/W: `users/{uid}` + subcoleções + Auth |
| 25 | `placeBid` | Callable | usuário autenticado | **Sem conceito de orgId no schema** | — | R/W: `auctionLots`, `auctionLots/*/bids`, R: `users/{uid}` |
| 26 | `encerrarLotesExpirados` | Scheduled a cada 1 min | — (sistema) | **Sem orgId no schema** | — | R/W: `auctionLots`; W: `auctionSales`, `auctionNotifications` |
| 27 | `gerarCobrancaLeilao` | Callable | admin/master OU parte da venda | **Sem orgId no schema** | Sim | R: `auctionSales`, `users`; W: `auctionPayments`, `users` |
| 28 | `auctionAsaasWebhook` | HTTP público | Token Asaas dedicado | **Sem orgId no schema** | Sim | R/W: `auctionPayments`, `auctionSales` |
| 29 | `liberarRepasse` | Callable | admin/master (role only) | **Sem orgId no schema** | — | R/W: `auctionSales`; W: `auctionNotifications` |
| 30 | `onSaleCreated` | Trigger `auctionSales/{id}` onCreate | — (sistema) | **Sem orgId no schema** | Sim | R/W: `users/{buyerUid}` |
| 31 | `verificarInadimplentesDiarios` | Scheduled `0 9 * * *` | — (sistema) | **Sem orgId no schema** | — | R/W: `auctionPayments`, `auctionSales`; W: `users`, `auctionNotifications` |
| 32 | `auditCpfs` | Callable (diagnóstico) | admin/master (role only) | **Não** — TODOS os `users`, retorna PII cross-tenant | — | R: `users` |
| 33 | `auditAsaasSync` | Callable (diagnóstico) | admin/master (role only) | **Não** — TODOS os `users`, retorna PII cross-tenant | — | R: `users` |
| 34 | `createEventRegistration` | Callable | — (público) | **`const orgId = 'org_bonfim'` hardcoded** | — | R: `cms_events`, `users`; R/W: `eventRegistrations` |
| 35 | `confirmEventCheckin` | Callable | usuário autenticado | Não checa orgId do registro vs. do operador (mitigado por token UUID) | — | R/W: `eventRegistrations` |

**Tipos de trigger confirmados no arquivo:** HTTPS Callable (23), Firestore Trigger onCreate/onUpdate (7), Scheduled/Pub-Sub (5 — sim, `functions.pubsub.schedule` é Pub/Sub por baixo), HTTP público (2 webhooks). **Não existem** Storage Triggers nem Auth Triggers (`onCreate`/`onDelete` de usuário do Auth) no arquivo — confirmado via grep, nenhum `functions.auth.user()` nem `functions.storage.object()`.

---

## 2. Mapa de dependências

```
Cliente (CCBMG / futuro Painel Master)
   │
   ├─▶ 23 Callable Functions ──▶ Firestore (Admin SDK — IGNORA Firestore Rules)
   │         │
   │         ├─▶ Secret Manager (5 segredos, todos ÚNICOS/globais — não por tenant)
   │         │     • asaas-api-key            (usado por 25 das 35 functions)
   │         │     • asaas-webhook-token      (asaasWebhook)
   │         │     • asaas-auction-webhook-token (auctionAsaasWebhook)
   │         │     • email-user / email-password (sendDailyPaymentReport, notifyAdminsByEmail)
   │         │
   │         └─▶ Asaas API (api.asaas.com) ── UMA ÚNICA CONTA para toda a plataforma
   │
   ├─▶ 2 Webhooks HTTP públicos ◀── Asaas (asaasWebhook, auctionAsaasWebhook)
   │
   └─▶ Firebase Auth (Admin SDK) ── resetUserPassword, completePasswordReset,
                                     deleteAssociado, startPasswordReset (Phone Auth)

7 Firestore Triggers (reagem a escrita de outro lugar, não são chamados diretamente):
   users/{uid} onCreate      → onNewAssociadoCriado ──▶ Asaas (cria cliente+assinatura)
   users/{uid} onUpdate      → onAssociadoAtualizado ──▶ Asaas (sync/pausa/reativa)
   financeInvoices onUpdate  → onInvoicePaid ──▶ syncManualPaymentToAsaas ──▶ Asaas
   financeInvoices onCreate  → onInvoiceCreatedPaid ──▶ syncManualPaymentToAsaas ──▶ Asaas
   auctionSales onCreate     → onSaleCreated ──▶ Asaas (cria cliente se faltar)

5 Scheduled (Pub/Sub interno do Cloud Scheduler, não configurável por tenant):
   08:00 diário  → sendDailyPaymentReport     (e-mail hardcoded, 2 destinatários fixos)
   04:00 diário  → asaasReconciliationDaily   (chama syncOneAssociado p/ TODOS os users)
   09:00 diário  → verificarInadimplentesDiarios (só módulo de leilão)
   a cada 1 min  → encerrarLotesExpirados     (só módulo de leilão)

Helpers internos compartilhados por múltiplas functions (efeito cascata se alterados):
   getAsaasApiKey()              → usado por ~20 functions — qualquer mudança de assinatura quebra todas
   findOrCreateAsaasCustomer()   → onNewAssociadoCriado, syncAllAssociadosToAsaas
   upsertInvoiceFromAsaasPayment() → asaasWebhook, syncManualPaymentToAsaas, syncOneAssociado,
                                      cancelOpenPayments, createImmediateChargeOnReactivation
                                      (5 pontos de entrada convergem numa função só — bom pra
                                      consistência hoje, é o ponto único de falha se precisar
                                      de lógica por-tenant amanhã)
   syncOneAssociado()            → asaasSyncAssociado (manual) E asaasReconciliationDaily (diária)
   cancelOpenPayments() / setCustomerNotificationsEnabled() / syncCustomerNotifications() /
   createImmediateChargeOnReactivation() → reusadas entre onAssociadoAtualizado,
                                            cancelMySubscription, reactivateMySubscription
   notifyAdminsByEmail()         → cancelMySubscription, reactivateMySubscription,
                                    completePasswordReset — sempre para os MESMOS 2 e-mails fixos
   mapRoleServer()                → toda function com checagem de role (~20 functions) —
                                     DUPLICA a lógica de mapRole do núcleo compartilhado
                                     (shared/core/auth/roles.js) só que no lado servidor, sem
                                     "adminView" — se o vocabulário de papel mudar num lugar e
                                     não no outro, cliente e servidor divergem.
```

**Dependências ocultas identificadas:**
1. `PLAN_VALUE`/`PLAN_CYCLE`/`PLAN_LABEL` (linha 1117-1119) são constantes **hardcoded no código**, nunca lidas de `organizations/{orgId}`. Confirmado via grep: a palavra `organizations` **não aparece uma vez** em todo o arquivo. Isso significa que o preço dos planos (R$30/85/170) está fisicamente impossível de variar por organização sem alterar e reimplantar código.
2. `mapRoleServer()` é uma segunda implementação do vocabulário de papel, paralela à do núcleo compartilhado (Fase 1) — não delega a nada, não é importada de lugar nenhum, apenas replicada.
3. `notifyAdminsByEmail` e `sendDailyPaymentReport` escrevem `contato@clubedocavalobonfim.com.br` como remetente e nomes fixos ("Clube do Cavalo Bonfim MG", "CCBMG") diretamente no corpo/assunto de e-mails — não há nenhum mecanismo de branding por tenant nas Functions (consistente com "Branding/White Label" estarem fora do escopo desta fase, mas o acoplamento existe e precisa ser resolvido quando essa fase chegar).

---

## 3. Tabela de classificação

| Categoria | Definição | Functions |
|---|---|---|
| **A — Já compatível** | Nenhuma alteração necessária | `onInvoicePaid`, `onInvoiceCreatedPaid` (escopadas 100% pelo path do documento que as disparou; a única pegada multi-tenant delas é via `getAsaasApiKey()` — ver Fase 2.2) |
| **B — Pequenas alterações, baixo risco** | Escopadas por `context.auth.uid` (self) ou por path de documento; risco é só o modelo de conta Asaas compartilhada, não vazamento de dados Firestore | `onNewAssociadoCriado`, `onAssociadoAtualizado`, `getAsaasPaymentLink`, `cancelMySubscription`, `reactivateMySubscription`, `asaasWebhook`, `confirmEventCheckin` |
| **C — Mudança de schema** | Precisam de campo `orgId` novo numa coleção que hoje não tem | `placeBid`, `encerrarLotesExpirados`, `gerarCobrancaLeilao`, `auctionAsaasWebhook`, `liberarRepasse`, `onSaleCreated`, `verificarInadimplentesDiarios` (todo o módulo de leilão — `auctionLots`/`auctionSales`/`auctionPayments`/`auctionNotifications` não têm `orgId` em nenhum documento), `createEventRegistration` (tem `orgId`, mas hardcoded — trocar o literal por resolução real é mudança pontual, não de schema) |
| **D — Relacionada ao Asaas** | Núcleo da integração financeira — tratamento à parte por causa do risco financeiro | `syncAllAssociadosToAsaas`, `createAsaasSubscriptions`, `configureAsaasNotifications`, `listAsaasCustomersRaw`, `verifyAsaasNotificationStandard`, `fixAsaasPhoneNumbers`, `asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`, `asaasGetPaymentStatus`, `asaasReconciliationDaily`, `gerarCobrancaLeilao` (também C) |
| **E — Relacionada à autenticação** | Mexem em Firebase Auth ou senha | `resetUserPassword`, `startPasswordReset`, `completePasswordReset`, `deleteAssociado` (também F) |
| **F — Alto risco, planejamento específico** | Sem filtro de organização em coleção que JÁ tem `orgId` (`users`), OU aceita um `uid`/`targetUid` de qualquer organização vindo do payload sem checar contra a organização de quem chama, OU expõe PII cross-tenant | `sendDailyPaymentReport`, `syncAllAssociadosToAsaas`, `createAsaasSubscriptions`, `configureAsaasNotifications`, `listAsaasCustomersRaw`, `verifyAsaasNotificationStandard`, `fixAsaasPhoneNumbers`, `asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`, `asaasReconciliationDaily`, `resetUserPassword`, `startPasswordReset`, `completePasswordReset`, `deleteAssociado`, `auditCpfs`, `auditAsaasSync` |

(Várias functions aparecem em mais de uma categoria — a classificação diz qual ATRIBUTO se aplica, e Fase 2.1–2.5 abaixo agrupa por ORDEM de migração, que é uma dimensão diferente.)

---

## 4. Auditoria arquitetural — padrões consolidados

**1. Já é multi-tenant?** Só 1 de 35: `createEventRegistration` — e mesmo essa com o valor de `orgId` hardcoded, não resolvido dinamicamente. As outras 34: **não**.

**2. Dependência implícita do CCBMG?** Sim, em praticamente todas: `PLAN_VALUE`/`PLAN_CYCLE`/`PLAN_LABEL` hardcoded; textos `"Mensalidade CCBMG"`, `"Clube do Cavalo Bonfim MG"`, e-mails fixos (`waldiney.serafim@gmail.com`, `mpmarquesnutri@gmail.com`, `contato@clubedocavalobonfim.com.br`); `org_bonfim` hardcoded em 1 function; `mapRoleServer` sem `adminView` (só o CCBMG usa esse papel hoje, mas a lista é hardcoded igual ao cliente).

**3/4/5/6. Leitura/escrita/atualização/remoção — filtro por orgId e risco cruzado:** ver coluna "orgId?" do Inventário (seção 1). Resumo: **17 das 35 functions fazem `db.collection('users').get()` ou equivalente sem NENHUM filtro** (leem/iteram a base inteira); **5 functions aceitam um `uid`/`targetUid` vindo do payload da chamada sem checar se pertence à mesma organização de quem chama** (`asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`, `resetUserPassword`, `deleteAssociado`) — esse é o achado de maior severidade individual da auditoria: como Cloud Functions usam o Admin SDK, **elas ignoram completamente as Firestore Rules corrigidas na Fase 0 (G3)**. A correção de G3 protegeu o acesso direto via SDK do cliente; não protege (e nunca protegeria) chamadas para essas Cloud Functions.

**7. Authentication — como identifica organização?** Nunca pelo token/claims do usuário (não há custom claims de `orgId` configurados em nenhuma function — confirmado, `setCustomOrgClaims`/`setCustomUserClaims` não aparece no arquivo). Identificação é sempre por **role** (`mapRoleServer`), nunca por organização.

**8. Storage:** **Nenhuma Cloud Function deste arquivo usa Firebase Storage.** Todo o upload de imagem (banners, produtos, avatares) acontece client-side, via `shared/utils/images.js` (Fase 0/1) — fora do escopo desta auditoria de Functions.

**9. Secret Manager:** 5 segredos, **todos compartilhados/globais**, nenhum por tenant: `asaas-api-key`, `asaas-webhook-token`, `asaas-auction-webhook-token`, `email-user`, `email-password`.

**10. Cloud Scheduler:** 5 jobs agendados (seção 2), todos operam sobre a base inteira sem segmentação por tenant — o mesmo agendamento/timezone (`America/Sao_Paulo`) serviria mal um tenant em outro fuso.

---

## 5. Auditoria financeira (Asaas)

| Function | Cliente | Assinatura | Cobrança | Consulta | Webhook | Atualiza cobrança | Atualiza assinatura | Atualiza associado |
|---|---|---|---|---|---|---|---|---|
| `onNewAssociadoCriado` | cria | cria | — | — | — | — | — | grava asaasId/subId |
| `onAssociadoAtualizado` | atualiza | pausa/reativa | — | — | — | — | atualiza | grava status sync |
| `syncManualPaymentToAsaas` (via onInvoicePaid/onInvoiceCreatedPaid) | — | — | — | consulta | — | baixa (receiveInCash) | — | — |
| `asaasWebhook` | — | — | — | consulta (anti-fraude) | recebe | upsert local | — | — |
| `asaasSyncAssociado`/`syncOneAssociado` | — | — | — | consulta | — | reconcilia local | — | grava summary |
| `asaasCreatePayment` | — | — | cria avulsa | — | — | — | — | — |
| `asaasCancelPayment` | — | — | cancela | — | — | marca cancelado | — | — |
| `cancelMySubscription`/`reactivateMySubscription` | — | pausa/reativa | cancela abertas / cria avulsa | — | — | — | — | grava flags |
| `gerarCobrancaLeilao`/`auctionAsaasWebhook` | cria (se faltar) | — | cria/recebe | — | recebe | atualiza `auctionPayments` | — | — |

**`externalReference`:** usado consistentemente como o **UID do Firebase** — é a âncora que faz o webhook e as reconciliações acharem o documento certo. Ponto forte do desenho atual.
**`asaasPaymentId`:** usado como chave de idempotência em `upsertInvoiceFromAsaasPayment` — busca por `where('asaasPaymentId','==',...)` antes de criar. Correto e testado (era a chave usada nos testes da Fase 0/G3).
**`asaasSubscriptionId` / `asaasId` (customerId):** gravados em `users/{uid}`, usados para todas as chamadas subsequentes de assinatura/cliente.

**Existe possibilidade de mistura entre organizações? SIM.** Dois vetores concretos, não hipotéticos:
1. **Conta Asaas única para a plataforma inteira.** `findOrCreateAsaasCustomer` busca cliente por `externalReference` (uid — seguro) mas tem *fallback* por CPF (linhas 970-979) que **não** verifica organização. Se a mesma pessoa física (mesmo CPF) for associada em dois tenants diferentes da plataforma (fisicamente possível — nada impede alguém de ser sócio de dois clubes distintos hospedados na mesma plataforma), o Asaas devolveria e **reutilizaria o cliente do tenant errado**, misturando cobranças de duas organizações no mesmo cadastro Asaas.
2. **`asaasSyncAssociado`/`asaasCreatePayment`/`asaasCancelPayment` aceitam `uid` do payload sem checar organização do chamador.** Um admin de qualquer organização, sabendo (ou adivinhando sequencialmente) o `uid` de um usuário de outra organização, consegue gerar ou cancelar uma cobrança dele. Hoje isso não é explorável de fora (precisa já ser admin/master de *alguma* organização na plataforma), mas deixa de ser teórico no dia em que existir o 2º tenant.

---

## 6. Auditoria de idempotência

| Function | Idempotente hoje? | Chave usada | Precisa incorporar orgId? |
|---|---|---|---|
| `upsertInvoiceFromAsaasPayment` (usada por 5 fluxos) | Sim | `asaasPaymentId` (global, único no Asaas) | Não tecnicamente (IDs do Asaas já são globalmente únicos) — **mas só enquanto houver 1 conta Asaas por toda a plataforma**. Se o modelo migrar para 1 conta Asaas por tenant, `asaasPaymentId` deixa de ser globalmente único e a chave real de dedupe precisa virar `(orgId, asaasPaymentId)` ou equivalente. |
| `asaasWebhook` / `auctionAsaasWebhook` | Sim, por construção (idempotência herdada de `upsertInvoiceFromAsaasPayment` / checagem de `asaasPaymentId` existente) | idem acima | idem acima |
| `onNewAssociadoCriado` | Parcial — `findOrCreateAsaasCustomer` evita duplicar cliente, mas não há proteção contra o trigger rodar 2x (reentrega do Firestore) criar 2 assinaturas, já que a criação de assinatura não checa se já existe uma antes de fazer `POST /subscriptions` | Sim, ganharia uma trava adicional, mas o problema de raiz (falta de checagem pré-criação) não é sobre orgId |
| `syncAllAssociadosToAsaas`/`createAsaasSubscriptions`/`fixAsaasPhoneNumbers` | Sim (checam `asaasId`/`asaasSubscriptionId` existente antes de agir) | campo no doc `users/{uid}` | Não — já é por documento |
| `checkAndIncrementResetAttempts` (rate limit de reset de senha) | Sim, mas chave é só `cpfDigits` | `cpfDigits` | Sim, no sentido de que hoje um CPF de qualquer tenant compartilha o mesmo contador de tentativas globalmente — comportamento aceitável (é rate-limit, não dado sensível), mas vale registrar. |

**Risco de reprocessamento incorreto:** o mais concreto é o de `onNewAssociadoCriado` acima (criação de assinatura duplicada em reentrega de evento) — não é um gap multi-tenant, é um gap de idempotência pré-existente que a migração deveria aproveitar para corrigir.

---

## 7. Auditoria de segurança (LGPD / isolamento / least privilege)

- **Least Privilege:** todas as functions administrativas usam o mesmo padrão de checagem (`role in [admin, master]`), nunca escopado a "admin desta organização". Isso é o oposto de least privilege num contexto multi-tenant: hoje, ser admin de qualquer organização (quando existir mais de uma) equivaleria a ser admin de todas, para efeitos de Cloud Functions.
- **Isolamento entre tenants:** inexistente nas Cloud Functions (Admin SDK ignora Firestore Rules). É a lacuna mais importante encontrada nesta auditoria — mais severa que G1/G2 como estavam descritos até aqui, porque G2 (documentado desde a Fase 0) descrevia "Functions sem filtro de `orgId`" como um problema de leitura em lote; esta auditoria encontrou que o problema também é de **escrita direcionada** (`uid` de payload não validado).
- **Risco de vazamento (LGPD):** `auditCpfs` e `auditAsaasSync` retornam nome + CPF de **todos** os usuários da base (não só da organização de quem chamou) para qualquer admin/master autenticado. Num cenário multi-tenant isso é vazamento de dado pessoal de uma organização para admins de outra — violação direta do princípio de minimização de dados da LGPD.
- **Risco de leitura cruzada:** `listAsaasCustomersRaw`/`verifyAsaasNotificationStandard` (nome, CPF/CNPJ, referência) — mesmo problema, via API do Asaas em vez do Firestore.
- **Risco de escrita cruzada:** `asaasCreatePayment`/`asaasCancelPayment`/`resetUserPassword`/`deleteAssociado` — já detalhado nas seções 4 e 5.
- **Risco financeiro:** concentrado no modelo de conta Asaas única (seção 5) e nas 3 functions de escrita sem checagem de organização.

---

## 8. Auditoria de custos

- **Firestore reads:** o padrão `db.collection('users').get()` sem filtro (presente em 8 functions: `sendDailyPaymentReport`, `syncAllAssociadosToAsaas`, `createAsaasSubscriptions`, `configureAsaasNotifications`* (via Asaas, não Firestore), `fixAsaasPhoneNumbers`, `asaasReconciliationDaily`, `auditCpfs`, `auditAsaasSync`) é uma leitura de **documento inteiro por usuário cadastrado, todo santo dia** (no caso de `asaasReconciliationDaily`, que roda diariamente às 4h) — hoje, com 1 organização pequena, irrelevante. Com dezenas/centenas de organizações compartilhando a mesma base `users`, cada uma dessas 8 rotinas passa a ler **N vezes mais documentos do que precisa** (lê todo mundo, usa só quem é da própria organização — nenhuma delas filtra depois de trazer os dados, exceto onde já teria de qualquer forma iterar em memória).
- **Escrita redundante:** não identificada como problema — as escritas são sempre por documento único (`update()`/`set()` em `users/{uid}` ou equivalente), não há padrão de batch desnecessário.
- **Consulta que escala mal:** `asaasReconciliationDaily` e `configureAsaasNotifications`/`verifyAsaasNotificationStandard` fazem **1 chamada de API externa (Asaas) por usuário**, com `setTimeout` de 100-250ms entre chamadas para respeitar rate limit — em 540s de timeout máximo (`runWith({timeoutSeconds:540})`), o teto físico é de aproximadamente 1300-2000 usuários processados por execução antes de estourar o timeout. Com múltiplas organizações compartilhando essas rotinas (se não forem migradas para agir por tenant), esse teto vira um risco real de a rotina parar de completar a base inteira.
- **Bandwidth/Cloud Functions:** sem padrão anômalo identificado além do já citado.

---

## 9. Auditoria do modelo de dados

| Coleção | Tem `orgId`? | Deveria ter? | Observação |
|---|---|---|---|
| `users` | Sim (gravado pelo client, Fase 0) | — | Cloud Functions raramente filtram por ele (só `createEventRegistration`) |
| `users/{uid}/financeInvoices` | Não (implícito via path) | Não precisa — já escopado pelo `uid` pai | — |
| `users/{uid}/finance/summary` | Não (implícito via path) | Não precisa | — |
| `organizations/{orgId}` | É a própria chave | — | **Nunca lida por nenhuma Cloud Function** — módulos/planos/preço 100% hardcoded no código |
| `passwordResetAttempts/{cpf}` | Não | Opcional — hoje é só rate-limit, não dado sensível de negócio | — |
| `eventRegistrations` | Sim, mas valor hardcoded (`'org_bonfim'`) | Já tem o campo — só falta resolver o valor dinamicamente | — |
| `auctionLots`, `auctionLots/*/bids` | **Não** | **Sim** — módulo inteiro de leilão não tem conceito de organização no schema | Índice novo necessário: `(orgId, status, endTime)` para `encerrarLotesExpirados` continuar eficiente |
| `auctionSales` | **Não** | **Sim** | Índice novo: `(orgId, lotId)`, `(orgId, status)` |
| `auctionPayments` | **Não** | **Sim** | Índice novo: `(orgId, status, dueDate)` para `verificarInadimplentesDiarios` |
| `auctionNotifications` | **Não** | Recomendável (para permitir limpeza/consulta por org no futuro) | — |
| `cms_events` | Já tem (fora do escopo desta auditoria — gerido pelo painel) | — | Lido, não escrito, por `createEventRegistration` |
| `systemLogs` | N/A | N/A | **Nunca escrito por Cloud Functions** — auditoria (`logAction`) é 100% client-side (núcleo compartilhado, Fase 1) |
| `systemPlans` | N/A | N/A | **Nunca lido por Cloud Functions** — não há enforcement server-side de plano/preço |

---

## 10. Gaps encontrados (lista consolidada)

1. **G2 confirmado e ampliado** — não são "7 Cloud Functions sem filtro de orgId" como documentado na Fase 0; são **17 leituras em lote sem filtro** + **5 escritas direcionadas sem checagem de organização do alvo** — 22 pontos de exposição no total, não 7.
2. **Novo, mais severo que G2**: Cloud Functions administrativas (`asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`, `resetUserPassword`, `deleteAssociado`) aceitam um `uid` alvo do payload sem validar que pertence à mesma organização de quem chama — bypassa completamente a correção de Firestore Rules da Fase 0 (G3), porque Admin SDK não passa pelas Rules.
3. **Novo**: preço e ciclo de cobrança dos planos (`PLAN_VALUE`/`PLAN_CYCLE`) são constantes hardcoded no código-fonte das Functions, nunca lidos de `organizations/{orgId}` — mesmo que G1 (client-side) e G3 (Firestore Rules) estejam corrigidos, o "preço da mensalidade" da plataforma inteira é, hoje, um valor de código-fonte compartilhado por todo mundo.
4. **Novo**: módulo de leilão inteiro (`auctionLots`, `auctionSales`, `auctionPayments`, `auctionNotifications`) não tem `orgId` em nenhum documento — não é um ajuste de filtro, é uma mudança de schema em 4 coleções.
5. **Novo**: `createEventRegistration` tem `const orgId = 'org_bonfim'` — G1-equivalente, mas do lado servidor, não corrigido pela Fase 1 (que só tratou o client `firebase.js`).
6. **Novo (LGPD)**: `auditCpfs`/`auditAsaasSync`/`listAsaasCustomersRaw`/`verifyAsaasNotificationStandard` retornam PII (nome, CPF, telefone) de usuários de **todas** as organizações para qualquer admin/master autenticado.
7. **Novo (modelo de negócio, não só técnico)**: toda a integração Asaas roda sobre **uma única conta/API key compartilhada** — multi-tenant financeiro de verdade (isolamento de recebíveis, extrato, taxa por organização) exige decisão de produto (sub-contas Asaas? conta própria por tenant?) antes de ser resolvido em código.
8. **Novo**: `mapRoleServer()` duplica o vocabulário de papel do núcleo compartilhado (Fase 1), sem `adminView`, sem nenhuma ligação com `shared/core/auth/roles.js` — risco de drift silencioso entre cliente e servidor.
9. **Novo (idempotência)**: `onNewAssociadoCriado` pode criar assinatura duplicada em reentrega de evento do Firestore (não checa se já existe assinatura antes do `POST /subscriptions`) — bug pré-existente, não introduzido por multi-tenant, mas na mesma vizinhança de código que será tocada na migração.
10. **Herdado, confirmado ainda presente**: e-mails/branding hardcoded (`waldiney.serafim@gmail.com`, `mpmarquesnutri@gmail.com`, `contato@clubedocavalobonfim.com.br`, "Clube do Cavalo Bonfim MG") em 4 pontos (`sendDailyPaymentReport`, `notifyAdminsByEmail` × 3 chamadores).

---

## 11. Riscos

**Arquitetura**
- Admin SDK ignora Firestore Rules — a suíte de proteção construída nas Fases 0-1 (núcleo compartilhado + G3) **não cobre nenhuma das 35 Cloud Functions**. Qualquer plano multi-tenant que não trate Functions como uma superfície de segurança separada (não "já protegida porque as Rules foram corrigidas") está incompleto.
- Toda a lógica de negócio específica de organização (preço, ciclo, papéis) está espalhada em constantes de módulo, não em dado configurável.

**Segurança**
- 5 functions com escrita direcionada sem checagem de organização (seção 4/7) — é o risco mais acionável e concreto desta auditoria.
- PII cross-tenant exposta em 4 rotinas de diagnóstico.

**Financeiro**
- Conta Asaas compartilhada — risco de mistura de cliente entre tenants via fallback por CPF, e ausência de qualquer separação de recebíveis por organização.
- Escrita financeira sem checagem de organização (`asaasCreatePayment`/`asaasCancelPayment`) — pode gerar ou cancelar cobrança de usuário de outra organização.

**Performance**
- `asaasReconciliationDaily`/`configureAsaasNotifications`/`verifyAsaasNotificationStandard` têm teto físico de usuários processáveis por execução (rate-limit interno + timeout de 540s) que **não escala** para múltiplas organizações compartilhando a mesma execução.

**Custos**
- 8 rotinas leem a coleção `users` inteira sem filtro — custo de leitura cresce linearmente com o total de usuários da plataforma, não da organização que a rotina deveria atender.

**Regressão**
- Qualquer mudança em `getAsaasApiKey()`, `upsertInvoiceFromAsaasPayment()` ou `mapRoleServer()` afeta, respectivamente, ~20, 5 e ~20 functions — são os 3 pontos de maior raio de impacto no arquivo inteiro. Migração precisa tratá-los com o mesmo cuidado que `firebase.js` recebeu na Fase 1 (testes antes/depois, sem mudar assinatura).
- Não existe suíte de testes automatizados para `functions/index.js` (diferente do CCBMG frontend, que tem os 11 arquivos Playwright usados nas Fases 0-1) — qualquer migração aqui não tem uma rede de segurança equivalente pronta; construir uma (ainda que mínima) é pré-requisito, não opcional.

---

## 12. Plano de Migração (sem implementar)

### Fase 2.1 — Functions de baixo risco
**Objetivo:** eliminar os gaps que são simples adição de filtro/parâmetro, sem tocar em dinheiro nem em Auth.
**Escopo:** `onInvoicePaid`, `onInvoiceCreatedPaid` (já corretas — só documentar); trocar `mapRoleServer()` para não divergir do núcleo compartilhado (ganho de consistência, não é sobre orgId); resolver o `orgId` hardcoded em `createEventRegistration` para vir de onde a página que chama already sabe (ela já vive num tenant único hoje — replicar o padrão do `tenant.config.js` do lado servidor é decisão de desenho desta etapa, não desta auditoria).
**Fora de escopo:** qualquer function que toque Asaas ou Auth.
**Riscos:** baixo — mudanças pontuais, sem superfície financeira.
**Rollback:** revert de commit único por function.
**Estratégia de testes:** criar (não existe hoje) uma suíte mínima de testes de emulador para Functions, nos moldes do que foi feito manualmente para G3 na Fase 0 — pelo menos 1 teste por function tocada.
**Critérios de aceite:** função continua idempotente, `createEventRegistration` deixa de ter literal hardcoded, nenhuma regressão nos testes e2e do frontend que dependem dessas functions (`tests/e2e/`).

### Fase 2.2 — Functions relacionadas ao Asaas
**Objetivo:** fechar os 5 pontos de escrita sem checagem de organização (`asaasSyncAssociado`, `asaasCreatePayment`, `asaasCancelPayment`) e decidir o modelo de conta Asaas (sub-conta por tenant vs. conta única com isolamento lógico reforçado) antes de tocar nas 8 rotinas em lote.
**Escopo:** adicionar checagem "uid do payload pertence à mesma organização de `context.auth`" nas 3 functions de escrita direcionada; redesenhar `syncAllAssociadosToAsaas`/`createAsaasSubscriptions`/`fixAsaasPhoneNumbers`/`asaasReconciliationDaily` para operar por organização (parâmetro `orgId` explícito ou filtro `where('orgId','==',...)`); mover `PLAN_VALUE`/`PLAN_CYCLE`/`PLAN_LABEL` para leitura de `organizations/{orgId}`.
**Fora de escopo:** decisão de produto sobre sub-contas Asaas (é pré-requisito de negócio, não de código — sinalizar para o dono do produto antes de iniciar).
**Riscos:** financeiro — é a fase de maior risco de todo o plano; qualquer engano aqui gera cobrança errada ou cancelamento indevido.
**Rollback:** por function, mas com atenção — se `PLAN_VALUE` já estiver migrado para Firestore quando outra function ainda espera a constante, há risco de inconsistência; migrar leitura de config antes de migrar a lógica de negócio que a usa.
**Estratégia de testes:** obrigatório testar contra o Asaas em Sandbox (não produção) antes de qualquer deploy; réplica do padrão de teste via emulador Firestore/Auth usado na Fase 0/1, mais mocks/sandbox para a API do Asaas.
**Critérios de aceite:** as 3 functions de escrita rejeitam uid de organização diferente; nenhuma rotina em lote itera usuários fora da própria organização; preço/ciclo configuráveis por organização e validados em pelo menos 1 organização de teste.

### Fase 2.3 — Functions relacionadas à autenticação
**Objetivo:** fechar `resetUserPassword`/`deleteAssociado` (checagem de organização do alvo) e `startPasswordReset`/`completePasswordReset` (filtro de `orgId` na busca por CPF).
**Escopo:** as 4 functions listadas.
**Fora de escopo:** qualquer mudança no fluxo de Phone Auth em si (mecanismo já validado, só falta o filtro).
**Riscos:** segurança/auth — erro aqui pode travar reset de senha legítimo ou, pior, permitir reset cross-tenant; é a 2ª fase de maior cuidado.
**Rollback:** por function.
**Estratégia de testes:** cenário de teste teria dois usuários com o MESMO CPF em duas organizações distintas de teste (caso hoje impossível de reproduzir em produção com 1 organização só) — precisa do emulador com dados sintéticos, igual ao padrão da Fase 1.
**Critérios de aceite:** busca por CPF sempre filtrada por organização; `resetUserPassword`/`deleteAssociado` rejeitam alvo de organização diferente da de quem chama.

### Fase 2.4 — Functions agendadas e automações
**Objetivo:** todas as 5 rotinas agendadas (seção 2) passam a operar por organização (iterar `organizations` e, para cada uma, processar só os usuários dela) em vez de "toda a base de uma vez".
**Escopo:** `sendDailyPaymentReport`, `asaasReconciliationDaily`, `verificarInadimplentesDiarios`, `encerrarLotesExpirados` (também depende da Fase 2.5 para o schema de leilão ganhar `orgId`), branding do e-mail por organização (fica registrado aqui, mas depende da Fase de Branding/White Label, fora do escopo geral do roadmap atual).
**Fora de escopo:** branding visual do e-mail em si (cores/logo) — só o *endereçamento* (quem recebe, de qual organização) entra aqui.
**Riscos:** performance/custo (seção 8) — validar que o novo desenho não estoura timeout com o número de organizações esperado nos próximos 12 meses.
**Rollback:** mais delicado que as fases anteriores porque são jobs agendados — rollback via revert de deploy + confirmação de que o próximo disparo agendado já roda a versão revertida.
**Estratégia de testes:** rodar manualmente (via `firebase functions:shell` ou invocação HTTP de teste) contra dados sintéticos de 2+ organizações antes de confiar no agendamento automático.
**Critérios de aceite:** cada rotina agendada processa cada organização de forma isolada (erro numa organização não impede as demais de serem processadas); tempo total de execução com N organizações de teste projetado dentro do timeout de 540s.

### Fase 2.5 — Limpeza de legado
**Objetivo:** remover/arquivar as rotinas de diagnóstico e migração pontual que não têm mais função permanente, e fechar o gap de schema do módulo de leilão.
**Escopo:** decidir o destino de `listAsaasCustomersRaw`, `verifyAsaasNotificationStandard`, `fixAsaasPhoneNumbers`, `auditCpfs`, `auditAsaasSync` (são ferramentas de auditoria/migração pontual — ou ganham checagem de organização e viram permanentes com escopo reduzido, ou são removidas depois de cumprida a função); adicionar `orgId` a `auctionLots`/`auctionSales`/`auctionPayments`/`auctionNotifications` e atualizar `placeBid`/`encerrarLotesExpirados`/`gerarCobrancaLeilao`/`auctionAsaasWebhook`/`liberarRepasse`/`onSaleCreated`/`verificarInadimplentesDiarios` para usá-lo; criar os índices compostos necessários (seção 9).
**Fora de escopo:** qualquer funcionalidade nova de leilão.
**Riscos:** regressão — é a fase que mais mexe em schema de dados já em uso (leilões ativos não podem perder lance/histórico durante a migração).
**Rollback:** migração de schema aditiva (novo campo opcional primeiro, backfill, só depois tornar obrigatório) para nunca ter uma janela em que documentos antigos fiquem invisíveis a queries que já exigem `orgId`.
**Estratégia de testes:** replicar exatamente o padrão usado para corrigir G3 na Fase 0 (testes de isolamento via emulador, usuários sintéticos de 2 organizações, confirmar que lance/venda/pagamento de uma organização não aparece pra outra).
**Critérios de aceite:** 4 coleções do módulo de leilão com `orgId` em 100% dos documentos (novos e migrados); rotinas de diagnóstico removidas ou explicitamente escopadas por organização; nenhuma function remanescente faz `.get()` sem filtro em coleção que deveria ser escopada.

---

## Pendências para além desta fase (fora do escopo do plano acima)
- Decisão de produto: modelo de conta Asaas por tenant (impacta diretamente o desenho da Fase 2.2).
- G4 (hospedagem multi-domínio) e migração real do Painel Master — inalterados, seguem como já registrado nas Fases 0/1.
- Branding/White Label nos e-mails automáticos — meramente registrado aqui como dependência futura da Fase 2.4, não deste plano.
- Construção da suíte de testes de Functions em si (hoje inexistente) é pré-requisito repetido em todas as sub-fases acima — vale considerar como um item único de infraestrutura antes de iniciar 2.1.

---

**Aguardando aprovação explícita antes de iniciar qualquer implementação — nenhuma alteração foi feita em código, nenhum commit foi criado, nada foi publicado, conforme restrição desta fase.**
