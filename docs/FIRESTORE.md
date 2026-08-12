# Firestore Security Rules — Análise Completa

> **Nota de escopo (agosto de 2026)**: levantamento de 2026-07-21, anterior aos helpers `isPlatformStaff()`/`isPlatformAdministrator()`/`isPlatformOwner()`/`isOrgMaster()`/`isOrgAdmin()`/`isOrgViewer()` e às regras de `organizations`/`platformAdmins`/`domains`/`featureFlags`/`provisioningRuns` (Fases 3.2–3.10) e ao autoatendimento `isOrgMasterSelfService()` (Fase 4) — a contagem de linhas abaixo também mudou. Ver `CLAUDE.md` (raiz deste repositório) para o modelo atual, e `firestore.rules` para o texto vigente.

Arquivo: `firestore.rules` (444 linhas na época deste levantamento, `rules_version = '2'`).

## Helpers (linhas 6-108)

| Helper | O que faz |
|---|---|
| `isLoggedIn()` | `request.auth != null` |
| `isSelf(userId)` | logado e `uid` bate com o doc alvo |
| `userRoleRaw()` | lê `users/{uid}.role` via `get()` (1 leitura extra por avaliação de regra) — vazio se doc não existe |
| `userOrgId()` | idem, para `orgId` |
| `roleLower()` | `.lower().trim()` da role bruta |
| `isMaster()` / `isAdminRole()` | comparação **exata** com `"master"` / `"admin"` — **não usa a mesma normalização tolerante de `mapRole()` do frontend**; uma role gravada como `"Admin View"` cai como não-admin nas regras (ver risco em [SECURITY.md](SECURITY.md)) |
| `canOperate()` | `isMaster() || isAdminRole()` — usado extensivamente para "quem pode escrever conteúdo administrativo" |
| `isAssociadoOrAdmin()` | `associado`, `admin` ou `master` — usado para permitir criação de `auctionLots` |
| `noSensitiveFieldChange()` | usado no `update` de `users`: bloqueia o próprio dono de alterar `role, status, inadimplenteLeilao, ativo, asaasId, asaasSubscriptionId, asaasSync, orgId, desativadoEm, desativadoPor, notaDesativacao, categoriaAssociado, responsavelCpf, responsavelUid` |
| `_hasOnlyKeys` / `_isInvoiceCreateValid` | validação estrita para o cliente poder criar a própria `financeInvoice` (ver [DATABASE.md](DATABASE.md)) |

## Regras por coleção

### `memberServices` / `memberProducts` (linhas 113-121)
Leitura: qualquer logado. Escrita: só `canOperate()`. Simples e coerente — catálogo administrado só por admin/master.

### `memberClassifieds` (linhas 126-168)
- **Leitura pública** (`allow read: if true`) — qualquer visitante vê classificados, mesmo não aprovados (a UI filtra `approved==true` na query, mas a regra em si não impede ler um documento não aprovado por `get` direto).
- **Criação**: logado + (`createdBy`==uid **ou** `ownerUid`==uid) — aceita dois nomes de campo de dono, refletindo a duplicidade histórica de convenção.
- **Atualização**: admin/master fazem tudo; o dono pode atualizar desde que não altere `approved`, `createdBy`, `ownerUid` — impede que o próprio anunciante se autoaprove.
- **Exclusão**: admin/master ou dono.

### `classificados` (linhas 173-215)
Coleção paralela/legada com regra quase idêntica (leitura `get,list: true`; criação por `ownerUid`/`createdBy`; update do dono não pode mudar `ownerUid`/`ownerEmail`/`createdBy`). Ver nota de divergência em [DATABASE.md](DATABASE.md) — duas coleções de classificados coexistindo é um ponto de atenção de manutenção, não uma vulnerabilidade em si.

### `users/{userId}` (linhas 220-268)
- `get`: dono ou `canOperate()`.
- `list`: **só `canOperate()`** — protege contra enumeração de toda a base de associados por um usuário comum.
- `create`: dono (signup) ou `canOperate()` (admin cadastrando).
- `update`: dono + `noSensitiveFieldChange()`, ou `canOperate()` (sem restrição de campo para admin/master — correto, é quem opera o CRM).
- `finance/{docId}` (inclui `summary`): leitura para dono/admin/master; escrita só admin/master (mas a Cloud Function usa Admin SDK, que ignora regras).
- `financeInvoices/{invId}`: leitura dono/admin/master; **criação pelo próprio dono permitida**, mas só com o conjunto estrito de campos de `_isInvoiceCreateValid()` (não pode se autodeclarar pago nem gravar `gatewayId`); escrita geral (edição/pagamento) só admin/master.

### Módulo de Leilões (linhas 274-350)

- `auctionLots`: `get` público apenas para status "públicos" (`publicado|encerrado|pago|concluido|cancelado`) — um `rascunho`/`em_analise`/`rejeitado` só é legível pelo próprio vendedor ou por admin/master. `list` para admin/master e `isAssociadoOrAdmin()` (participantes de leilão não listam, só fazem `get` direto de um lote específico — coerente com a UI, que não mostra listagem geral para esse papel). `create` restrito a `sellerUid==self` e status inicial `rascunho`/`em_analise`. `update` tem 4 ramos (ver análise detalhada abaixo).
- `bids`: leitura para qualquer logado; **escrita sempre `false`** — só a Cloud Function `placeBid` (Admin SDK) grava, garantindo atomicidade/anti-fraude no lance.
- `auctionSales`/`auctionPayments`: leitura restrita às partes envolvidas ou admin/master; escrita sempre `false`.
- `auctionNotifications`: leitura só do destinatário; `update` restrito a marcar `read`; `create`/`delete` sempre `false`.

**Achado de segurança (brecha na regra de update de `auctionLots`, linhas 290-316):** a 2ª cláusula (dono pode atualizar em `rascunho`/`rejeitado`, desde que não toque campos de aprovação/lance) **não restringe o valor final de `status`** — tecnicamente um vendedor autenticado poderia, via chamada direta ao SDK (fora da UI), gravar `status:"publicado"` num lote próprio que esteja em `rascunho`, pulando a aprovação do admin. As cláusulas 3 e 4 (transições específicas `rascunho→em_analise` e `rascunho→cancelado`) são redundantes e ficam encobertas pela permissividade da 2ª cláusula. Detalhado com risco/prioridade em [SECURITY.md](SECURITY.md).

### Multi-tenant/SaaS (linhas 356-382)
`organizations`: `list` só master; `get` master ou mesma org; `write` só master. `systemPlans`: leitura qualquer logado, escrita só master (coleção sem dado real, ver [TECH_DEBT.md](TECH_DEBT.md)). `systemLogs`: leitura só master; criação por qualquer logado desde que `userId==auth.uid` (não pode forjar log em nome de outro usuário); update/delete sempre `false` (imutável, correto para um audit trail). `organizationSubscriptions`/`systemConfig`: leitura e escrita só master.

### CMS (linhas 388-428)
Todas (`cms_banners`, `cms_events`, `cms_partners`, `cms_board`, `cms_gallery` + subcoleção `fotos`, `cms_about`): leitura pública, escrita só `canOperate()`. Consistente e simples.

### `eventRegistrations` (linhas 433-442)
Leitura pública (o controle de acesso ao comprovante é feito na aplicação via `viewToken`, não na regra — ver [SECURITY.md](SECURITY.md) para análise de risco de enumeração). Criação pública (sem login) desde que `orgId` seja string não vazia — validação de negócio real (CPF, duplicidade, prazo, sócio em dia) é feita **na Cloud Function** `createEventRegistration`, não na regra. `update` só admin/master (check-in manual, cancelamento). `delete` sempre `false`.

## Riscos identificados (resumo — detalhado com prioridade em [SECURITY.md](SECURITY.md))

1. `isAdminRole()`/`isMaster()` comparam string exata, sem a tolerância de `mapRole()` do frontend — um `role` gravado como `"Admin"` (maiúscula) ou `"Admin View"` passa no frontend mas **falha** em `canOperate()` nas regras (case-sensitive: `.lower()` só normaliza caixa, não remove "view"/espaços extras do jeito que `mapRole` faz) → potencial bloqueio de operações legítimas de Admin View, ou pior, ambiguidade de que "Admin View" é tratado como "associado" pelas regras (sem privilégio de escrita administrativa) enquanto a UI acredita que ele tem acesso de leitura facilitado.
2. Brecha de `auctionLots.update` (rascunho→publicado direto pelo dono, contornando aprovação).
3. Leitura pública de `memberClassifieds`/`classificados`/`eventRegistrations` sem paginação/rate limit nas regras — mitigado apenas pelos índices e pela ausência de dados sensíveis nesses documentos (exceto CPF/telefone em `eventRegistrations`, ver Segurança).
4. Duas coleções de classificados com regras quase idênticas — risco de manutenção (uma regra corrigida, a outra esquecida), não risco de dado exposto per se.

## Melhorias recomendadas (sem alterar a simplicidade do projeto)

- Corrigir `auctionLots.update` para validar explicitamente que `request.resource.data.status` só pode ir para `em_analise` ou `cancelado` nesse ramo (nunca `publicado`), fechando a brecha sem adicionar complexidade.
- Alinhar `isAdminRole()`/`isMaster()` com a mesma normalização de `mapRole()` (remover acentos/"view"), ou formalizar `adminView` como papel de regra próprio, para eliminar a ambiguidade entre frontend e regras.
- Considerar restringir `eventRegistrations` `get` a exigir conhecimento do `viewToken` (não é possível checar isso puramente na regra sem duplicar o token como id do documento ou campo indexado de igualdade — hoje a proteção é 100% na aplicação, o que é aceitável dado o baixo valor do dado exposto, mas vale registrar como decisão consciente, não acidental).
