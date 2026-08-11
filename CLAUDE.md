# CCBMG — Claude Code Context

## Organização
**Clube do Cavalo de Bonfim MG (CCBMG)**
Site: https://clubedocavalobonfim.com.br
Repositório: https://github.com/waldineyserafim/clubedocavalobonfimmg
Firebase Project: `clubecavalobonfim`

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | HTML5 + CSS3 + Bootstrap 5.3 + JavaScript Vanilla (ES Modules) |
| Hospedagem | GitHub Pages (domínio via CNAME) |
| Auth | Firebase Authentication (CPF → email interno `cpf@cpf.local`) |
| Banco | Firestore |
| Storage | Firebase Storage (imagens comprimidas ~200 KB) |
| Backend | Cloud Functions (Node.js 22) |
| Pagamentos | **Asaas** (assinaturas recorrentes, PIX/boleto/cartão, webhooks) ✅ |
| Segredos | Google Secret Manager |

---

## Estrutura de Arquivos

### Área Pública
- `index.html` — Home
- `events.html` — Eventos
- `classificados.html` — Classificados públicos
- `gallery.html` — Fotos
- `partners.html` — Parcerias
- `board.html` — Diretoria
- `sobre.html` — Sobre o Clube

### Área do Associado (requer login)
- `login.html` — Login por CPF
- `signup.html` — Cadastro público (define própria senha; sem primeiroAcesso)
- `pg_associado.html` — Dashboard do associado (banners, status, produtos, serviços, classificados, trocar senha)
- `produtos_associado.html` — Produtos exclusivos
- `servicos_associado.html` — Serviços exclusivos
- `pay.html` — Pagamento (planos Mensal R$30 / Trimestral R$85 / Semestral R$170)
- `pay-success.html` — Confirmação de pagamento
- `reset_senha.html` — Redefinição de senha

### Área Administrativa (requer role admin ou master)
- `admin.html` — Painel principal
- `admin_associados.html` — Gestão de associados + financeiro + faturas
- `admin_produtos.html` — Gestão de produtos
- `admin_servicos.html` — Gestão de serviços
- `admin_classificados.html` — Moderação de classificados

### Código Central
- `firebase.js` — Módulo central: auth, Firestore, Storage, helpers de role, upload de imagem com compressão
- `functions/index.js` — Todas as Cloud Functions (relatório diário + integração Asaas completa)

---

## Firestore Schema

```
users/{uid}
  cpf, nome, apelido, telefone, endereco,
  role (master|admin|associado),
  status, ativo, createdAt, updatedAt,
  primeiroAcesso (bool) — true quando criado pelo admin; false após trocar senha,
  planType (mensal|trimestral|semestral),
  asaasId (string) — ID do cliente no Asaas,
  asaasSyncedAt (Timestamp),
  asaasSubscriptionId (string) — ID da assinatura no Asaas,
  asaasSubscriptionSyncedAt (Timestamp),
  desativadoEm (Timestamp), desativadoPor (uid), notaDesativacao (string) —
    gravados pelo admin junto com ativo:false (admin_associados.html); ativo:false
    bloqueia login (login.html) e Firestore rules — só o admin usa esse mecanismo,
  assinaturaCanceladaEm (Timestamp), assinaturaCanceladaPeloAssociado (bool) —
    gravados pelo próprio associado (cancelMySubscription), SEM tocar em ativo,
    para não bloquear login antes do fim da vigência paga (ver seção Autocancelamento)

users/{uid}/finance/summary
  activeUntil, nextDue, lastPayment, lastAmount, exempt, exemptUntil, balance

users/{uid}/financeInvoices/{invoiceId}
  amount, dueDate, paidAt, status, planType, planStart, planEnd,
  asaasPaymentId (string) — ID do pagamento no Asaas (idempotência no webhook)

memberProducts/{id}
  title, description, benefit, imageUrls[], whatsapp, price, active

memberServices/{id}
  title, description, benefit, imageUrl, whatsapp, active

classificados/{id}
  title, description, imageUrls[], whatsapp, price, active, approved,
  ownerUid, ownerEmail, createdAt

events / partners  (coleções simples)

platformAdmins/{uid}  — Fase 3.2, equipe da Serafim Technologies, NUNCA tem orgId
  role (owner|administrator|operator), nome, email, ativo,
  createdAt, updatedAt, createdBy (uid de quem criou, ou "migration_fase3_2")
  — escrita só via Cloud Functions (Admin SDK); Firestore Rules bloqueiam
  qualquer escrita direta do cliente (ver seção "Fase 3.2" abaixo)

organizations/{orgId}  — campos adicionados na Fase 3.3, além dos já documentados
  provisioningStatus (running|completed|failed), provisionedAt, provisionedBy (uid),
  billingProvider (string, campo do TOPO — o que getBillingProvider() de verdade lê,
    não confundir com config.billingProvider, que é histórico/cosmético),
  config.{idioma,timezone,moeda} (Fase 3.1, populado automaticamente no provisionamento)

organizations/{orgId}  — campos adicionados na Fase 3.4 (Central de Configuração)
  nomeCurto, descricao, pais (Geral),
  config.{dateFormat,timeFormat,logoUrl,faviconUrl,corPrimaria,corSecundaria,
    notificationsEnabled,fromEmail,fromName} (Localização/Identidade/Comunicação),
  billingEnvironment (sandbox|producao — conectado de verdade em getBillingProvider()),
  billingStatus (ativo|pausado — só informativo, sem enforcement ainda),
  billingConfig.publicParams (mapa livre, nunca credencial),
  portal.redesSociais {facebook,instagram,youtube},
  integrations (mapa vazio por padrão — reservado, sem integração real ainda)

provisioningRuns/{runId}  — Fase 3.3, rastreamento/auditoria de provisionOrganization
  orgId, requestedBy (uid), requestedByEmail, planId,
  status (running|completed|failed), startedAt, finishedAt,
  steps: [{name, status: ok|error|skipped, startedAt, finishedAt, error}]
  — escrita só via Cloud Functions, mesma garantia de platformAdmins

domains/{hostnameNormalizado}  — Fase 3.5, registro hostname → orgId
  orgId, tipo (primario|alternativo), status (verificado — único valor usado nesta fase),
  criadoEm, criadoPor, atualizadoEm
  — escrita só via Cloud Function setOrganizationDomains (unicidade garantida
  entre organizações), leitura pública (precisa resolver antes de login)

organizations/{orgId}/public/branding  — Fase 3.5, projeção pública e curada
  nome, nomeCurto, logoUrl, faviconUrl, corPrimaria, corSecundaria,
  modules, billingProvider, updatedAt
  — mantida por trigger onOrganizationWritten (nunca escrita direta do
  cliente); NUNCA inclui observações/billingConfig/integrations do documento
  pai — é o único jeito de expor branding pra visitante anônimo sem abrir
  organizations/{orgId} inteiro (que exige login+mesma org desde a Fase 3.2)
```

---

## Autenticação e Roles

- CPF é convertido para email: `12345678900` → `12345678900@cpf.local`
- Roles de **organização** (`users/{uid}.role`, sempre com `orgId`): `master` (Organization Master) > `admin` (Organization Administrator) > `operador` (Organization Operator) > `Admin View` (Organization Viewer) > `associado`/`participanteLeilao` — ver seção "Fase 3.2" para o que cada um pode
- Roles de **plataforma** (`platformAdmins/{uid}`, nunca tem `orgId`): `owner` > `administrator` > `operator` — plano de identidade inteiramente separado, ver "Fase 3.2"
- Role cacheada em `sessionStorage` para evitar reads redundantes ao Firestore
- Proteção de rotas via `requireAuth({ requiredRole })` em `firebase.js` (organização) / `requirePlatformAccess({ requiredRole })` em `admin/assets/admin-auth.js` do Portal Associativo (plataforma)
- Botão "Administração" aparece dinamicamente para admin/master via `setupAdminButton()`
- `mapRoleServer(r)` normaliza roles com espaços/acentos via `.normalize('NFD').trim().toLowerCase().includes()`

### Primeiro Acesso
- Quando admin cria associado: `primeiroAcesso: true` gravado no Firestore
- Em `pg_associado.html`: se `primeiroAcesso === true`, abre modal de troca de senha obrigatória (backdrop static, sem botão fechar)
- Após trocar a senha: `primeiroAcesso: false` gravado no Firestore
- Associados que se auto-cadastraram via `signup.html` não têm esse campo

---

## Fase 3.2 — Administração da Plataforma ✅

Substituiu definitivamente o `master` plano e cross-tenant (`isMaster()` em `firestore.rules`, sem checagem de organização nenhuma) por dois planos de identidade genuinamente separados. O que foi eliminado não foi a palavra "master" — foi o mecanismo de bypass cego a organização; "master" sobrevive só como rótulo de um papel **de organização** (Organization Master), sempre comparado a um `orgId`.

### Modelo de papéis

**Plataforma** (`platformAdmins/{uid}`, equipe da Serafim Technologies, nunca tem `orgId`):
| Papel | Pode |
|---|---|
| `owner` | Tudo que `administrator` pode + gerenciar outros `administrator`/`owner` + ações irreversíveis |
| `administrator` | Criar/editar organizações, gerenciar planos, gerenciar `operator` (não `administrator`/`owner`), auditoria global |
| `operator` | Somente leitura nas telas de plataforma — zero escrita |

**Organização** (`users/{uid}.role`, sempre com `orgId`, nunca cruza tenant):
| Papel | Pode |
|---|---|
| `master` (Organization Master) | Tudo que `admin` pode + alterar o papel de qualquer membro da equipe administrativa da própria org (único papel que pode) |
| `admin` (Organization Administrator) | Operação plena do dia a dia (associados, conteúdo, financeiro, moderação) — **não** pode alterar papel de ninguém |
| `operador` (Organization Operator) | Tarefas pontuais (ex.: check-in de evento) |
| `Admin View` (Organization Viewer) | Somente leitura nas telas administrativas |

`associado`/`participanteLeilao` não mudaram — fora desta reforma, é a base de membros comum, não equipe administrativa.

### Cloud Functions (`functions/lib/platform.js`)

`resolvePlatformAdmin(uid)`/`requirePlatformStaff`/`requirePlatformAdministrator`/`requirePlatformOwner` — mesmo padrão de `organization.js`/`authorization.js`, mas para um resolvedor que nunca lida com organização nenhuma.

| Callable | Quem chama | Regra |
|---|---|---|
| `createPlatformAdmin({email,nome,role})` | administrator/owner | administrator só cria `role:"operator"`; owner cria qualquer papel; envia link de definição de senha por e-mail (nunca senha em texto puro) |
| `setPlatformAdminStatus({uid,ativo})` | administrator/owner | administrator só ativa/desativa `operator`; proíbe auto-alteração; proíbe deixar zero owners ativos |
| `setPlatformAdminRole({uid,newRole})` | **owner apenas** | proíbe auto-alteração; proíbe deixar zero owners ativos |
| `deletePlatformAdmin({uid})` | administrator/owner | exclusão definitiva (Firestore + Auth) — diferente de `setPlatformAdminStatus` (soft delete, reversível); administrator só exclui `operator`, mesma escalada de `createPlatformAdmin`/`setPlatformAdminStatus`; proíbe auto-exclusão; proíbe excluir o último owner ativo |
| `migratePlatformAdmins` | uso único — gate é o mecanismo antigo (`role==="master"` em `users/{uid}`, sem passar por organização) | migra toda conta `master` legada pra `platformAdmins` com `role:"owner"`; não apaga o doc antigo, só neutraliza `role` pra `"migrado_para_platform_admins"` (não-destrutivo, idempotente) |

`backfillLeilaoOrgId` (utilitário de migração da Fase 2C) foi reclassificado de `requireOrganizationMaster` para guarda de plataforma — sempre foi, mecanicamente, uma operação cross-org, nunca de autoatendimento de uma organização.

Todas as 4 callables de gestão de equipe gravam auditoria diretamente em `systemLogs` via Admin SDK (atestado pelo servidor) — `platformAdmins` não permite nenhuma escrita direta do cliente (ver Firestore Rules abaixo), então essa é a única fonte de auditoria dessas mutações. Botão "Excluir" em `admin/platform-operators.html` (Painel Master) usa `confirm()` nativo antes de chamar — é a única ação irreversível dessa tela, as demais (ativar/desativar, mudar papel) são reversíveis.

### Firestore Rules

Helpers novos: `isPlatformStaff()`/`isPlatformAdministrator()`/`isPlatformOwner()` (leem `platformAdmins/{uid}`) e `isOrgMaster(orgId)`/`isOrgAdmin(orgId)`/`isOrgViewer(orgId)` (leem `users/{uid}`, sempre comparando organização — substituem o antigo `isMaster()`/`isAdminRole()`).

Duas coleções de `orgId`-bypass distintas:
- **Coleções puramente de plataforma** (`organizations`, `systemPlans`, `systemLogs`, `organizationSubscriptions`, `systemConfig`): trocaram `isMaster()` → `isPlatformStaff()`/`isPlatformAdministrator()` (granularidade por papel onde importa).
- **Coleções com bypass OR'd a admin de organização** (`users`, `memberServices`, `memberProducts`, leilão, `classificados`): leitura mantém visibilidade de plataforma (+ Organization Viewer, que antes não tinha nenhuma); **escrita removeu o bypass de plataforma** — só quem pertence à própria organização escreve. Campo `role` em `users/{userId}` especificamente só pode ser alterado por Organization Master (antes, `admin` comum também podia).

`platformAdmins/{uid}`: leitura = próprio doc ou qualquer membro da equipe de plataforma; **escrita sempre `false`** — só Cloud Functions (Admin SDK) escrevem.

Testado com `@firebase/rules-unit-testing` (nova devDependency) em `functions/test/rules.test.js` (`npm run test:rules`) — primeira cobertura de Rules de verdade do projeto (o resto de `functions/test/` usa Admin SDK, que ignora Rules por completo).

### Painel Master (Portal Associativo)

`admin/assets/admin-auth.js` é o único arquivo que sabe como a autorização é resolvida (`requirePlatformAccess()`) — repontado de `users`/`role==="master"` pra `platformAdmins`/`owner|administrator|operator`; as 8 páginas que já existiam desde a Fase 3.1 não mudaram. Nova página `admin/platform-operators.html` (CRUD de equipe de plataforma) e nova aba "Equipe" (somente leitura) em `admin/organization-detail.html`.

### Consequência operacional

Depois de rodar `migratePlatformAdmins`, nenhum `users/{uid}` tem `role==="master"` até um humano designar um Organization Master de verdade pra cada organização (não há promoção automática — sem sinal seguro pra escolher quem). Até lá, `resetUserPassword`/`deleteAssociado` (que exigem Organization Master) ficam inacessíveis — não é regressão de código, é ausência temporária de alguém com esse papel.

---

## Fase 3.3 — Provisionamento Automático de Organizações ✅

Substituiu o antigo "criar organização = `setDoc` num documento" pelo mecanismo oficial e único de criação de tenants: `provisionOrganization` (Cloud Function, `functions/lib/provisioning.js`). Criar uma organização passou a significar criar um ambiente completo — doc + primeiro Organization Master (conta Auth nova, nunca reaproveitada da plataforma) + módulos do plano + estrutura de Billing Provider (sem credencial) + branding básico + CMS mínimo — idempotente, com auditoria por etapa.

### Como funciona

7 passos sequenciais, cada um com checagem de existência própria (idempotente): `organization` (+ `plan`, escrita atômica via `.create()` — não `.set()`, pra resolver corrida de dois chamadores concorrentes pro mesmo `orgId`), `masterAccount` (cria conta Auth + `users/{uid}` — recupera de uma conta Auth órfã se um reprocessamento encontrar uma criada numa tentativa anterior sem o doc correspondente), `modules` (copia `systemPlans/{planId}.modules` pra `organizations/{orgId}.modules`), `billing` (escreve `organizations/{orgId}.billingProvider = "asaas"` — campo do TOPO, o que `getBillingProvider()` de verdade lê), `branding` (`organizations/{orgId}.config.{idioma,timezone,moeda}`), `storage` (não-op deliberado e registrado — object storage não tem pasta pra pré-criar), `cms` (`cms_about/{orgId}`, o único singleton real).

**Convite ao Master só depois que tudo terminar** (nunca no passo `masterAccount`) — evita um Master recém-criado entrar numa organização sem módulo/branding nenhum no meio do provisionamento.

**Validação prévia** (antes de qualquer escrita): `systemPlans/{planId}` precisa existir; `master.email` não pode já ser uma conta em `platformAdmins` ("nunca reaproveitar conta de plataforma").

### `provisioningRuns/{runId}` — rastreamento/auditoria

`{orgId, requestedBy, planId, status:"running"|"completed"|"failed", startedAt, finishedAt, steps:[{name,status,startedAt,finishedAt,error}]}`. Atualizado incrementalmente (a cada passo, não só no fim) — sobrevive a um timeout no meio da execução com registro exato de até onde chegou. Leitura = qualquer papel de plataforma; escrita = só Cloud Functions (mesma garantia estrutural de `platformAdmins`).

### Rollback: sem exclusão automática

Nenhum passo desfaz o anterior em caso de falha — reprocessamento idempotente é a estratégia (ver `provisionOrganization` no relatório da Fase 3.3, `portal-associativo/docs/roadmap/`, pra justificativa completa por passo). "Reprocessar" (`forceReprocess:true`) é uma feature de primeira classe, não uma exceção — timeout de 300s numa function com Auth SDK no meio é esperado.

### Caminhos manuais fechados de verdade

`firestore.rules`: `organizations` teve `write` separado em `allow create: if false` (só a Cloud Function cria) + `allow update: if isPlatformAdministrator()` (as outras abas do Painel Master continuam editando normalmente). `admin_master_associacoes.html` (painel antigo) perdeu o botão/modal de "Nova Associação" — só edita organizações já existentes.

### Correção de bug encontrado

`organizations/{orgId}.config.billingProvider` (aninhado) era escrito pela aba Configurações desde a Fase 3.1 mas nunca lido por `functions/lib/billing/index.js` (que lê `org.billingProvider`, no topo) — os dois campos coexistiam sem ligação. Corrigido: a aba Configurações agora lê/escreve o campo real.

---

## Fase 3.4 — Configuração por Organização ✅

"Criar organização" (Fase 3.3) e "administrar organização" (Fase 3.2) já existiam; faltava "cada organização administrar as próprias configurações" sem precisar editar Firestore à mão. A antiga aba "Configurações" (que literalmente dizia "reservado para as próximas fases") virou a Central de Configuração — 8 categorias reais, no Painel Master (`admin/organization-detail.html`).

### O que mudou de lugar (não de dado)

A aba "Dados" encolheu pra só o que a PLATAFORMA administra (plano, status/ciclo de vida, observações, slug). Identificação/contato (nome, cnpj, telefone, email, site, endereço) saiu de lá e entrou em Configurações → Geral — mesmo documento `organizations/{orgId}`, mesma escrita (`update`, nunca `create`), só outra aba.

### As 8 categorias

| Categoria | O que administra |
|---|---|
| Geral | nome, nome curto, descrição, telefone, e-mail, site, CNPJ, endereço completo, país |
| Localização | idioma, timezone, moeda, formato de data, formato de hora (`organizations/{orgId}.config`) |
| Identidade Visual | logo/favicon (upload real via `createImageUploader`, `tenants/{orgId}/branding/`), cores primária/secundária — estrutura administrável, sem nenhum consumidor ainda (White Label é Fase 3.5) |
| Financeiro | `billingProvider`, `billingEnvironment` (sandbox/produção — **conectado de verdade**, ver abaixo), `billingStatus` (só informativo), `billingConfig.publicParams` (mapa livre, nunca credencial) |
| Comunicação | WhatsApp, notificações (liga/desliga, sem envio real), SMTP/remetente (reservado, sem envio real) |
| Portal | redes sociais (`organizations/{orgId}.portal.redesSociais`) — conteúdo institucional (missão, benefícios) continua só no painel antigo do CCBMG, migrar aquele editor é fora de escopo (é conteúdo, não configuração) |
| Integrações | `organizations/{orgId}.integrations` — mapa vazio, estado vazio honesto na UI, nenhum campo fabricado sem integração real pra moldar o formato |
| Segurança | somente leitura — trilha de auditoria desta organização (`systemLogs` filtrado por `details.orgId`) |

Cada categoria tem seu próprio botão salvar e sua própria ação de auditoria (`org_config_geral_atualizada`, `org_config_localizacao_atualizada` etc.) — granularidade deliberada, a própria aba Segurança exibe esses nomes.

### `billingEnvironment` conectado de verdade

`functions/lib/billing/asaas.js` ganhou `SANDBOX_BASE_URL`; `createAsaasBillingProvider` resolve a URL real a partir de `environment` (`sandbox` → `sandbox.asaas.com`, ausente → produção, retrocompatível). A decisão de "o que sandbox significa" fica no arquivo específico do Asaas, não no resolvedor genérico (`getBillingProvider()` só repassa `environment` cru) — nenhuma regra de negócio comum deve assumir "é Asaas".

### Storage Rules — lacuna da Fase 3.3 corrigida

`storage.rules`: `tenants/{orgId}/cms/{categoria}/{arquivo}` e o novo `tenants/{orgId}/branding/{arquivo}` agora comparam o `{orgId}` do caminho com a organização de quem está enviando (`firestore.get()` cross-service, mesma lógica de `userOrgId()` de `firestore.rules`) — antes, qualquer usuário autenticado podia escrever no caminho de qualquer organização. Achado empírico registrado em `functions/test/storage-rules.test.js`: a leitura cross-service só resolveu corretamente contra o projectId real (`clubecavalobonfim`) no emulador local, não contra um projectId de teste isolado (ao contrário de `rules.test.js`, que é Firestore puro e não tem esse problema).

---

## Fase 3.5 — Identidade do Tenant e Domínios ✅

Consome, pela primeira vez, os campos de branding que a Fase 3.4 tornou administráveis mas que nada lia ainda. Não é White Label (isso é fase futura) — é só "a organização passa a operar com sua própria identidade visual e domínio registrado", usando exclusivamente infraestrutura já existente.

### `domains/{hostnameNormalizado}` — novo, registro hostname → orgId

```
domains/{hostnameNormalizado}   — doc ID = hostname em minúsculas, sem protocolo/porta/path
  orgId       — referência a organizations/{orgId}
  tipo        — "primario" | "alternativo"
  status      — "verificado" (único valor usado nesta fase — sem verificação de DNS automática)
  criadoEm, criadoPor, atualizadoEm
```

Único escritor: `setOrganizationDomains({orgId, dominioPrincipal, dominiosAlternativos})` (Cloud Function, `functions/lib/domains.js`), gate `requirePlatformAdministrator`. Garante unicidade de verdade (um hostname nunca pertence a duas organizações — rejeita com `already-exists` se já registrado para outro `orgId`), espelha `dominioPrincipal` em `organizations/{orgId}.dominio` (campo já existente desde antes desta fase, continua sendo o que `organizations.html`/`admin_master_associacoes.html` exibem), remove do Firestore os domínios alternativos que saíram da lista num salvamento seguinte, audita em `systemLogs` (`org_dominio_atualizado`). Leitura pública (`allow get: if true` em `firestore.rules`) — é um índice hostname→orgId sem dado sensível, precisa resolver antes de qualquer login; `list` restrito a `isPlatformStaff()`; escrita direta do cliente sempre negada.

Gerido pela Central de Configuração → Geral (Portal Associativo, `admin/organization-detail.html`): campo "Domínio principal" + lista de "Domínios adicionais" (adicionar/remover), chamando a callable ao clicar Salvar — mesma auditoria por categoria da Fase 3.4.

### `organizations/{orgId}/public/branding` — novo, projeção pública e curada

A Fase 3.4 adicionou a `organizations/{orgId}` campos que não podem ser públicos (`observações` internas, `billingConfig`, `integrations`) — e a regra de leitura do documento (`allow get` exige login + mesma organização) corretamente reflete isso. Só que branding precisa aparecer pra visitante anônimo, antes de qualquer login. Em vez de abrir o documento inteiro (vazaria os campos da 3.4), uma subcoleção curada — mesmo padrão já usado em `users/{uid}/finance/summary`:

```
organizations/{orgId}/public/branding
  nome, nomeCurto, logoUrl, faviconUrl, corPrimaria, corSecundaria,
  modules, billingProvider, updatedAt
```

Mantida por trigger `onOrganizationWritten` (`functions/lib/organizationPublicSync.js` + export em `functions/index.js`, `onWrite` em `organizations/{orgId}`) — cobre tanto a Central de Configuração quanto qualquer edição legada em `admin_master_associacoes.html`, sem depender de cada tela lembrar de sincronizar. Leitura pública (`allow get: if true`), `list` sempre bloqueado (evita enumeração), escrita direta do cliente sempre negada — só o trigger escreve.

### Consumo — `shared/core/tenant/branding.js` (Portal Associativo) + `firebase.js`

`branding.js` espelha `modules.js` (mesmo padrão de cache em `sessionStorage`, 10 min): `getOrgBranding()` lê `organizations/{orgId}/public/branding`; `applyBranding()` aplica favicon (injeta/atualiza `<link rel="icon">`), `--brand`/`--brand-dark` (CSS custom properties, `corPrimaria`/`corSecundaria`) e `[data-tenant-name]`/`[data-tenant-logo]` (marcadores adicionados na navbar de `index.html`/`events.html`/`classificados.html`/`gallery.html`/`partners.html`/`board.html`/`sobre.html`) — só sobrescreve o que o branding realmente tem; campo ausente = o HTML/CSS estático de cada página continua valendo (fallback automático por construção, nunca quebra a página). `firebase.js` chama `applyBranding()` automaticamente ao ser importado, mesmo padrão de efeito colateral automático já usado por `_initNavbarUser` (deliberadamente fora do núcleo compartilhado — ver `shared/README.md`, "O que NUNCA vai para o núcleo").

### `getTenant()` — `domain` novo, resolução por hostname ainda não

`shared/core/tenant/tenant-context.js`'s `getTenant()` agora inclui `domain: location.hostname` no objeto resolvido (síncrono, sem leitura de rede). O corpo continua confiando em `window.__TENANT_CONFIG__.orgId` (`tenant.config.js`) — decisão deliberada: hoje cada deployment (GitHub Pages, CNAME único por repositório) já serve uma única organização, então uma consulta a `domains/{hostname}` no boot de toda página pública adicionaria latência e um novo modo de falha sem ganho observável. `domains/{hostname}` já existe como registro de governança; passa a ser o que `getTenant()` de fato consulta quando a hospedagem passar a suportar múltiplos domínios por deployment (ver `docs/SAAS_MULTITENANT.md`, gap G4 — decisão de infra ainda não tomada, fora de escopo desta fase).

### Fora de escopo desta fase (documentado, não implementado)

- Resolução hostname→orgId via Firestore no boot de cada página — depende de G4.
- HTTPS para múltiplos domínios — o único domínio real já tem TLS via GitHub Pages/Let's Encrypt; TLS de um segundo domínio depende da mesma decisão de hospedagem de G4.
- Verificação de propriedade de DNS automática — `status` de `domains` fica fixo em `"verificado"` nesta fase.
- White Label completo, editor de tema, múltiplos layouts.

---

## Fase 3.6 — Hardening, Operação e Go Live Comercial ✅

Última fase do MVP: auditoria completa (segurança/isolamento, qualidade/performance de Cloud Functions, operação/documentação) antes de aceitar clientes pagantes. Achado central, confirmado direto contra o projeto Firebase (não só o repositório): **nada da Fase 3.2 em diante jamais foi deployado em produção** — `platformAdmins` vazia, 36 de 43 Cloud Functions ao vivo, `firestore.rules` sem mudar desde antes da Fase 3.2, `storage.rules` sem mudar desde antes da Fase 3.4. O relatório completo, incluindo o Go-Live Checklist com a sequência exata de deploy pendente, está em `portal-associativo/docs/roadmap/FASE3_6_HARDENING_GO_LIVE_REPORT.md`.

### Patch crítico (produção, independente desta fase)

Duas vulnerabilidades confirmadas idênticas em produção e no repositório, corrigidas e deployadas via `firestore.rules` isoladamente (não o acumulado da Fase 3.2-3.6):
- `users/{userId}` create: `isSelf(userId)` sem validação de campo permitia auto-cadastro gravar `role:"master"` e tomar qualquer organização. Restrito a `role in ["associado","participanteLeilao"]` + `orgId` de organização existente.
- `eventRegistrations`: `allow read: if true` permitia `list()` público (nome/CPF/telefone/token de todos os eventos, todas as organizações). Split `get` (público, comprovante por ID) / `list` (exige admin/master da própria org).

### Correções de segurança/qualidade (repositório, aguardando deploy)

- `asaasCancelPayment`/`asaasGetPaymentStatus` — `asaasPaymentId` do payload agora precisa pertencer ao uid já validado (`assertPaymentBelongsToUid`) antes de agir — antes, qualquer admin podia consultar/cancelar cobrança de outra organização (conta Asaas compartilhada).
- `storage.rules` `uploads/{category}` — dono gravado via `customMetadata.uid` no upload, exigido na regra (`resource == null || resource.metadata.uid == request.auth.uid`); antes, zero checagem, qualquer usuário sobrescrevia imagem de qualquer outro.
- `migratePlatformAdmins` — só aceita chamada enquanto `platformAdmins` está genuinamente vazia; fecha pra sempre a superfície que, encadeada com a vulnerabilidade de auto-cadastro acima, levava de anônimo a Platform Owner.
- `sendDailyPaymentReport` — um e-mail por organização (antes unia destinatários e dados de todas as organizações num e-mail só).
- `storage.rules` `tenants/{orgId}/branding` — aceita também `isPlatformAdministrator()` (antes só `isOwnOrg`, que a equipe de plataforma nunca satisfaz — upload de logo/favicon da Fase 3.4 era estruturalmente impossível).
- Auditoria em `systemLogs` adicionada a `deleteAssociado`, `resetUserPassword`, `asaasCreatePayment`, `asaasCancelPayment` (antes só `console.log`).
- `onNewAssociadoCriado` grava `asaasSync.lastSyncError` em falha (antes só logava — zero sinal de que um novo associado ficou sem assinatura Asaas).
- `confirmEventCheckin` restrito a admin/master/operador/adminView (código aceitava qualquer associado; comentário já documentava a intenção correta).
- Índice composto `financeInvoices` (`dueDate`+`status`) adicionado — faltava pra query de fallback do webhook.
- Dead code removido: bloco `_internal` de exports de teste; botões "Seed"/"Migração" em `admin_master_configuracoes.html` (chamavam Cloud Functions inexistentes).

### Operação

- **Firestore Point-in-Time Recovery habilitado em produção** (7 dias) — antes, nenhum backup configurado ou documentado.
- Painel Master (`portal-associativo/admin/*.html`) passou a versionar os imports do núcleo compartilhado (`?v=2026.08.4`), igual ao CCBMG — antes, ficava exposto ao cache de 4h do Cloudflare sem nenhum cache-busting, justamente no consumidor com maior raio de impacto (autenticação/sessão de toda a plataforma).
- `docs/` (pasta de documentação técnica gerada em 2026-07-21, nunca reconciliada) marcada explicitamente como desatualizada, apontando pra este arquivo como fonte de verdade — a seção que antes instruía o contrário foi corrigida.

### Testes

192 testes de backend (0 falhas) — 139 `functions/test` + 38 Rules + 15 Storage Rules, incluindo uma organização de teste provisionada do zero via `provisionOrganization` com isolamento completo confirmado contra dados moldados como o CCBMG real. Suíte e2e Playwright (produção): 1258 passed / 86 failed, idêntico à baseline da Fase 3.5.

---

## Deploy Controlado da Fase 3.6 ✅ — Fases 3.2–3.6 em produção

Tudo que a Fase 3.6 documentou como "aguardando deploy" está publicado: Storage Rules, Firestore Rules + índices, as 44 Cloud Functions, `migratePlatformAdmins` executada uma única vez (Platform Owner migrado), domínio do CCBMG registrado, branding dinâmico configurado, backup semanal do Firebase Auth (`backupAuthUsers`, domingo 3h BRT, `backups/auth/{data}.json`, retenção 90 dias) e 2 alertas mínimos no Cloud Monitoring (erro geral de Cloud Functions + `asaasWebhook` dedicado). Um segundo tenant de teste (`org_teste_etapa10`) foi provisionado e validado com isolamento cross-tenant confirmado, e mantido em produção. Relatório completo: `portal-associativo/docs/roadmap/ETAPA1_DEPLOY_CONTROLADO_FASE3_6_REPORT.md`.

**Correções publicadas nesta rodada** (repositório e produção, núcleo compartilhado em `?v=2026.08.7`):
- `shared/core/tenant/branding.js` — `[data-tenant-name]` da navbar pública usava `nomeCurto` em vez de `nome` completo; invertido (`nome || nomeCurto`), `nomeCurto` preservado onde já era o campo certo.
- `shared/components/sidebar.css`/`data-table.css` — `.ds-admin-main` sem `width`/`min-width` (herdava `min-width:auto` de flex item) somado a `overflow:visible` causava overflow horizontal sistêmico no Painel Master (36/45 combinações página×viewport testadas, incluindo desktop 1920px); corrigido com `width` explícito + `overflow-x:auto`.
- Logs críticos (`asaasWebhook`, triggers de billing automático, falha de passo em `provisionOrganization`) migrados de `console.error`/`warn` para `functions.logger` — o runtime atual não popula `severity` no Cloud Logging a partir de `console.*`, o que deixava os alertas do Cloud Monitoring sem funcionar de verdade.

## Auditoria Final RC1 ✅ — GO WITH CONDITIONS

Auditoria de prontidão comercial da plataforma inteira (não só CCBMG), com evidência real contra produção — drift, isolamento cross-tenant, escalada de privilégio, billing, Storage, backup, alertas, E2E. **Resultado: GO WITH CONDITIONS — P0: 0, P1 em aberto: 0, P2: 2, P3: 7.** Relatório completo com a tabela de achados: `portal-associativo/docs/roadmap/AUDITORIA_FINAL_RC1_REPORT.md`.

**Achado P1 (encontrado e corrigido durante a própria auditoria)**: `startPasswordReset` (reset de senha self-service via SMS) retornava o telefone completo do associado pra qualquer chamada anônima com um CPF válido, sem nenhuma prova de identidade, com busca global entre organizações quando `orgId` não era informado. `signInWithPhoneNumber()` do Firebase Phone Auth é client-driven por construção — o número precisa chegar ao JS do navegador pra disparar o SMS, não existe alternativa server-side, então zero exposição não era alcançável sem trocar o mecanismo de SMS. Mitigado sem mudar esse mecanismo: `orgId` passou a ser obrigatório (fecha a busca global) e um token de **reCAPTCHA Enterprise** (chave própria, `6Ld-m38tAAAAAI6Useox6aHfJ6WpxySYIfzl_Qx7`, escopada a `clubedocavalobonfim.com.br`, verificada no servidor via IAM/`google-auth-library` — sem secret pra gerenciar, independente do `RecaptchaVerifier` opaco do Phone Auth) passou a ser exigido antes de qualquer consulta ao Firestore. `completePasswordReset` (validação do claim `phone_number` assinado pelo Firebase) e o disparo do SMS em si não foram alterados. Limitação residual documentada: um ataque manual e direcionado (CPF já conhecido do atacante) ainda obtém o telefone — o reCAPTCHA eleva o custo de automação/enumeração em massa, não elimina um ataque pontual.

**P2/P3 abertos, aceitos como dívida técnica futura** (não bloqueiam operação comercial — ver relatório da auditoria pra detalhe de cada um): forja de `systemLogs` por qualquer usuário autenticado (RC1-02); cobertura parcial de `functions.logger` nos alertas (RC1-03); fallback `org_bonfim` inalcançável em 2 functions (RC1-04); `encerrarLotesExpirados` a cada 1 min, ponto de atenção se leilão escalar entre tenants (RC1-05); 5 índices Firestore órfãos (RC1-06); `role:"Master"` capitalizado no provisionamento, inconsistente com `"master"` minúsculo (RC1-08); as 86 falhas conhecidas da suíte E2E (RC1-09) — mais os já documentados antes desta auditoria: bloqueio de DELETE via cliente em `branding`/`cms`, conta Asaas compartilhada entre tenants (G7), ausência de resolução hostname→orgId em tempo real (G4).

**Limitação conhecida, não é bug**: CCBMG não tem Organization Master ativo desde a migração do Platform Owner (Fase 3.2) — decisão operacional, não corrigida automaticamente por design (sem sinal seguro pra escolher quem). Consequência: os painéis administrativos do próprio CCBMG não puderam ser validados interativamente; `resetUserPassword`/`deleteAssociado` seguem inacessíveis até alguém ser designado pelo mecanismo do próprio app.

---

## Fase 3.7 — Tenant Sandbox Oficial da Plataforma ✅

A plataforma sempre teve um único ambiente Firebase (`clubecavalobonfim`) — sem projeto de staging separado. Esta fase resolve isso sem criar um segundo projeto: transforma um tenant já existente no ambiente permanente de desenvolvimento funcional, homologação, QA, demonstrações comerciais, treinamento e validação de integrações — **nunca dados reais**. Não é um tenant qualquer; é *o* Sandbox oficial da plataforma (singular), do mesmo jeito que CCBMG é hoje o único tenant de produção real.

### Identificação — nunca por nome

```
organizations/org_teste_etapa10
  nome: "Clube dos Associados"           — só exibição, igual a qualquer outra organização
  isSandbox: true                        — a ÚNICA fonte de verdade sobre "isto é o Sandbox"
  environment: "sandbox"
  isDemoTenant: true
```

Qualquer código futuro que precise se comportar diferente num tenant de demonstração (throttling mais permissivo, banners de aviso, exclusão de relatórios agregados, etc.) deve checar `organizations/{orgId}.isSandbox === true` — nunca `nome === "Clube dos Associados"` ou qualquer variação de string. O nome é só rótulo; pode mudar sem quebrar nada que dependa da flag.

### Asaas Sandbox — reaproveitando a resolução por organização que já existia

A Fase 3.4 já tinha criado `getBillingProvider({org, getSecret, defaultSecretName})` (`functions/lib/billing/index.js`) e `createAsaasBillingProvider({apiKey, environment})` (`functions/lib/billing/asaas.js`, que já resolvia `sandbox.asaas.com` vs `api.asaas.com` a partir de `org.billingEnvironment`) — e todo o outbound (criar cliente, assinatura, cobrança, cancelar, etc.) já passava por `getProviderForOrg(orgId)` em `functions/index.js` desde então. Ou seja: **a "camada única de resolução do ambiente de pagamento" pedida nesta fase já existia** — não foi criada de novo, só configurada e, pela primeira vez, exercitada com uma segunda conta Asaas de verdade.

```
organizations/org_teste_etapa10
  billingProvider: "asaas"
  billingEnvironment: "sandbox"
  billingConfig.secretName: "projects/clubecavalobonfim/secrets/asaas-sandbox-api-key/versions/latest"
```

Qualquer Cloud Function que já chamava `getProviderForOrg(userData.orgId)` (criação de assinatura, sincronização de dados cadastrais, cancelamento/reativação self-service, cobrança avulsa, etc.) automaticamente passou a falar com o Asaas Sandbox para este tenant, com **zero mudança de código** nesses pontos — só a configuração da organização mudou. CCBMG (`org_bonfim`) continua sem `billingEnvironment` (ausente = produção, comportamento 100% retrocompatível).

**A única lacuna real**: o webhook (inbound) nunca tinha sido pensado por-organização — o comentário original de `asaasWebhook` já dizia "só passa a ser por-organização quando existir mais de uma conta Asaas na plataforma" (Fase 2B). Esta fase chegou nesse ponto. Como o Asaas configura webhook por CONTA (não por payload — não há como saber a organização antes de validar o token), a solução foi mirror do padrão que `auctionAsaasWebhook` já usava (endpoint + secret dedicados), não um roteamento em tempo de requisição:

| Função | Token (Secret Manager) | Provider |
|---|---|---|
| `asaasWebhook` (inalterado no comportamento) | `asaas-webhook-token` | conta Asaas Production (CCBMG e demais tenants futuros de produção) |
| `asaasSandboxWebhook` (novo) | `asaas-sandbox-webhook-token` | conta Asaas Sandbox (só o tenant Sandbox oficial) |

Ambos chamam o mesmo `handleAsaasWebhookRequest()` extraído de dentro de `asaasWebhook` — nenhuma lógica duplicada. A assinatura de webhook em si foi criada via `POST /v3/webhooks` da própria API do Asaas Sandbox (não precisa do painel manualmente): URL `https://us-central1-clubecavalobonfim.cloudfunctions.net/asaasSandboxWebhook`, eventos `PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED`, `authToken` = valor do secret `asaas-sandbox-webhook-token` (gerado por este projeto, não pelo Asaas — é o mesmo token que a Cloud Function espera no header `asaas-access-token`). Validado ponta a ponta nesta fase: uma cobrança real marcada como recebida no Asaas Sandbox disparou o webhook, que criou `financeInvoices` e atualizou `finance/summary` no Firestore automaticamente, sem nenhuma intervenção manual.

### Seed Oficial — `functions/scripts/seedSandboxTenant.js`

Não existia nenhum seed reaproveitável antes desta fase (`functions/test/helpers/seed.js` é infraestrutura de teste contra o emulador, não um seed de tenant real). O novo script roda direto contra produção via REST (Firestore, Identity Toolkit/Auth, Secret Manager), autenticado com `gcloud auth print-access-token` do operador logado — sem depender de Application Default Credentials nem de uma chave de serviço distribuída.

```
node functions/scripts/seedSandboxTenant.js [team|associados|financeFollowup|events|partners|classificados|repairAsaasLinks|all]
```

- **Guarda de segurança**: antes de qualquer escrita, confirma `organizations/{SANDBOX_ORG_ID}.isSandbox === true` (mesma flag da seção acima) — recusa rodar contra qualquer outra organização, mesmo se `SANDBOX_ORG_ID` for trocado por engano.
- **Idempotência por ID determinístico**: todo documento usa prefixo `sandbox_` (`sandbox_master_01`, `sandbox_assoc_01..35`, `sandbox_evt_01..05`, etc.) e `seedTag: "sandbox-seed-v1"`. Reexecutar nunca duplica.
- **`users/{uid}` é campo minado para overwrite total**: esse documento é co-dono de Cloud Functions (`onNewAssociadoCriado` grava `asaasId`/`asaasSubscriptionId`/`asaasSync`; `onAssociadoAtualizado` reage a mudanças de `ativo`). Um `PATCH` sem `updateMask` (overwrite completo) *apaga* esses campos a cada reexecução — bug real, encontrado e corrigido durante esta fase (ver "Riscos e correções" no relatório da Fase 3.7). A correção — `upsertUserFields()`, que só grava os campos explicitamente passados via `updateMask.fieldPaths` — é a razão de existir do passo `repairAsaasLinks` (reconstrói o vínculo com o Asaas Sandbox a partir de `findCustomerByExternalReference`/`listSubscriptionsByCustomer` quando algo precisar ser recuperado).
- **Sincronização real, não simulada**: criar os 40 associados/mirins com `cpf`/`role:"Associado"` dispara `onNewAssociadoCriado` de verdade (mesmo trigger de produção), que cria cliente + assinatura reais no Asaas Sandbox. O passo `financeFollowup` usa `provider.cancelSubscription()` (cancelados) e `provider.receiveInCash()` (adimplentes) — chamadas reais à API do Asaas Sandbox, reaproveitando `lib/billing/asaas.js` sem nenhum código novo de integração.
- **Equipe administrativa** (Master/2×Admin/2×Operador): sem `cpf` (não são associados pagantes — evita disparar `onNewAssociadoCriado`), e-mail fictício em `@sandbox.invalid` (TLD reservado pela IANA, nunca resolve de verdade), login por `login_master.html` (não `login.html`, que é exclusivo do fluxo CPF→`@cpf.local`).
- **Distribuição de cenários** entre os 35 associados normais: 1–15 adimplentes (cobrança confirmada de verdade no Asaas Sandbox via `receiveInCash`), 16–20 inativos (`ativo:false` real, dispara `onAssociadoAtualizado` pausando a assinatura), 21–25 cancelados (`assinaturaCanceladaPeloAssociado:true` + assinatura pausada de verdade, sem tocar `ativo` — mesmo contrato do autocancelamento self-service), 26–30 inadimplentes (fatura vencida há 20 dias, escrita direta no Firestore), 31–35 recém-cadastrados (assinatura criada agora, primeira cobrança em aberto, sem pós-processamento). Os 5 Mirins seguem o fluxo normal de cobrança (sem CPF próprio, cobrados no CPF do responsável, valor pela metade — mesma regra de `resolvePlanValue()`).
- **Senha padrão** de todas as contas fictícias: `SandboxDemo#2026` (env `SANDBOX_SEED_PASSWORD` sobrescreve).

### Fora de escopo desta fase (decisão deliberada)

- **Módulo de Notícias**: não existe em nenhum dos dois repositórios (nem coleção, nem tela admin, nem exibição pública — só menção em copy de marketing do Portal Associativo). Construir um módulo novo é mudança de produto, não seed de tenant; não foi feito.
- **Produtos/Serviços/Galeria/Diretoria/Leilões**: módulos ativados no plano (`plan: "enterprise"`, todos os módulos `true`) para o tenant ficar pronto pra uso, mas sem dados fictícios seedados — não estavam no escopo original desta fase (Usuários/Eventos/Parceiros/Classificados/Financeiro). Ficam como "estado vazio honesto" até alguém pedir.

---

## Fase 3.8 — Ambiente Local, CI/CD e Feature Flags ✅

Três lacunas de engenharia resolvidas de forma definitiva (não paliativa): ambiente local 100% funcional, pipeline de qualidade no GitHub Actions (sem automatizar deploy) e uma camada de Feature Flags multi-tenant. Pensada para "dezenas ou centenas de organizações" — nenhuma solução aqui assume o tamanho atual da plataforma.

### Ambiente local — Java era o único bloqueio real

`firebase emulators:start` (Firestore/Storage) depende de um binário `java` no PATH — ausente nesta máquina, o que impedia rodar `functions/test/*` localmente (só era possível contra produção, o problema identificado na sessão anterior). Resolvido com `brew install openjdk` + `export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"` (openjdk do Homebrew é keg-only, não se auto-linka) — **sem sudo, sem symlink de sistema**, só PATH da sessão de shell, documentado em `docs/DEVELOPMENT.md` para qualquer máquina. Validado rodando a suíte completa: **193 verificações passando localmente** (139 unidade/integração + 38 Firestore Rules + 15 Storage Rules) antes desta fase acrescentar mais 26 (Feature Flags) — 219 no total ao final.

Scripts novos (raiz `package.json`, `functions/package.json`):
- `npm install` → dispara `postinstall` → instala `functions/` junto (não precisa rodar duas vezes).
- `npm run dev` → `firebase emulators:start --only firestore,auth,functions,storage`. **Hosting emulator não é usado** — o frontend é servido pelo GitHub Pages, não Firebase Hosting (documentado, não é lacuna).
- `npm test` → `firebase emulators:exec` envolvendo `functions/test:all` (unidade + Rules + Storage Rules, os três em uma única sessão de emulador — antes, cada um exigia uma invocação manual separada contra um emulador já de pé, sem nenhum comando único).
- `npm run lint` → ESLint (flat config, `eslint.config.js`) — escopo deliberadamente restrito a `functions/**`, `firebase.js`, `tenant.config.js` (núcleo compartilhado, maior alcance de bug). **Não** lint os `<script type="module">` inline das dezenas de páginas admin — nunca foram escritas pensando em lint, cobertura ali seria ruído sem consertar bug nenhum; ver comentário no topo de `eslint.config.js`.
- `npm run build` → `scripts/check-syntax.js` (`node --check` em todo `.js` do repo). Este projeto não tem bundler (GitHub Pages serve estático, Cloud Functions roda `.js` como está) — "build" aqui é o equivalente honesto de "quebrou a build" numa stack sem etapa de compilação, não uma etapa decorativa.
- `.nvmrc` (`22`, mesma versão de `functions.engines.node`) — reduz "funciona local, quebra no deploy".

**Decisão documentada — sem "typecheck"**: projeto 100% JavaScript vanilla, sem TypeScript e sem JSDoc com verificação de tipo em nenhum arquivo. Um step de typecheck aqui não checaria nada de verdade — cargo-culting de template genérico é exatamente o tipo de "solução paliativa" que este prompt pediu pra evitar. Se o projeto adotar TS/JSDoc no futuro, é aí que este step ganha sentido (ver Recomendações no relatório da fase).

### CI/CD — `.github/workflows/ci.yml`

Dois jobs paralelos e independentes, PR e push em `main`, **sem automatizar deploy** (continua manual, via `firebase deploy` local, como sempre foi):
- `lint-and-build` — rápido, sem Java: `npm ci` → `npm run lint` → `npm run build`.
- `test` — instala Java (`actions/setup-java@v4`, Temurin 21) + Firebase CLI, roda `npm test` (mesmo comando que um dev roda local — zero divergência entre "passa no meu commit" e "passa no CI").

Cache de dependências via `actions/setup-node@v4` (`cache: npm`); `concurrency` cancela runs obsoletos do mesmo PR. Branch protection (GitHub → Settings → Branches, exigir os checks `lint-and-build`/`test` antes de merge) é um passo manual de configuração do repositório — a Cloud Function/workflow não consegue se auto-configurar como obrigatório, só o painel do GitHub decide isso.

**Validação desta fase**: os comandos reais (`npm ci`, `npm run lint`, `npm run build`, `npm test`) rodaram e passaram nesta máquina antes do workflow ser considerado pronto — mesma disciplina que o workflow força no CI. `act` (executor local de GitHub Actions) foi instalado mas não usado de fim a fim: exige Docker rodando (via Colima aqui), que não estava ativo, e subir uma VM só para essa validação extra foi julgado desproporcional — pendência anotada no relatório, não um "confiei sem checar".

### Feature Flags — `functions/lib/features.js`

A parte mais substancial da fase. Deploy ≠ Release: uma funcionalidade pode estar no código publicado sem estar disponível pra ninguém (ou pra quase ninguém) até uma decisão explícita, sem outro deploy.

**Schema — `featureFlags/{flagKey}`** (coleção nova, plataforma):
```
key, description, category ("experiment"|"beta"|"premium"|"killswitch"|"other" — só rótulo/filtro, nunca muda a lógica de resolução)
status: "off" | "on" | "rollout"
rolloutPercentage: number (0-100, só relevante com status="rollout")
overrides: { [orgId]: boolean }  — SEMPRE vence status/rollout; é o único mecanismo pra
  beta interno/cliente piloto (override:true) E desligamento emergencial por tenant
  (override:false) — não precisa de "modo" separado pra cada caso de uso
environments: string[] | null — restringe por organizations/{orgId}.environment
  (Fase 3.7), NUNCA por nome de organização
archived: boolean — soft-state; nunca hard-delete (mesma filosofia de ativo:false já usada em toda a base)
createdAt, updatedAt, createdBy, updatedBy
```

**Resolução — função pura, testável sem Firestore** (`resolveFlag(flag, org)` em `lib/features.js`): override da organização sempre vence; senão `environments` filtra; senão `status` decide (`off`→false, `on`→true, `rollout`→bucket determinístico via hash `key+orgId`, mesma org sempre no mesmo grupo conforme o % sobe). **Fail-CLOSED pra flag desconhecida/arquivada** — divergência deliberada do fail-open de `modules.js`/`branding.js`: lá, campo ausente = entitlement herdado (age como sempre agiu); aqui, flag desconhecida = funcionalidade nova/incompleta que nunca foi ligada explicitamente — o padrão seguro é não vazar.

**Por que o cliente NÃO lê `featureFlags/{flagKey}` direto (ao contrário de `modules.js`/`branding.js`)**: o documento agrega o mapa `overrides` de **todas** as organizações da plataforma. Se exposto via `getDoc()` client-side, qualquer usuário logado de qualquer organização veria pra quais outras organizações um recurso está ligado — vazamento cross-tenant. Solução: `resolveFeatureFlags` (Cloud Function callable) é a **única porta de entrada do cliente**, devolve só o mapa já resolvido (flagKey→booleano) pra UMA organização, nunca o documento cru. Firestore Rules restringem leitura direta de `featureFlags/*` a `isPlatformStaff()` — só o Painel Master (que precisa administrar, não só consumir) lê a coleção inteira.

**Camada única, sem IFs espalhados**: toda checagem de flag passa por `featureService.isEnabled(key, org)` (dentro de Cloud Functions) ou pela callable/`shared/core/tenant/features.js` (cliente) — nenhuma outra parte do sistema lê `featureFlags` do Firestore.

**Cloud Functions** (`functions/index.js`): `resolveFeatureFlags` (qualquer membro autenticado, resolve a própria org; Platform Staff pode passar `orgId` pra pré-visualizar outra — uso do Painel Master), `createFeatureFlag`/`setFeatureFlagStatus`/`setFeatureFlagOverride`/`archiveFeatureFlag` (Platform Administrator/Owner, auditados em `systemLogs` via `writePlatformAuditLog`, mesmo mecanismo já usado pra `platformAdmins`).

**Cliente** — `shared/core/tenant/features.js` (portal-associativo), mesma FORMA de `modules.js`/`branding.js` (factory com DI, cache em `sessionStorage`, fail-safe, `applyFeatureVisibility()` simétrico a `applyModuleVisibility()` via `[data-feature="chave"]`) mas fonte de dado diferente (callable, não `getDoc()` direto — ver acima). TTL de cache do cliente: 1 min (vs. 10 min de módulos/branding — uma flag muda com muito mais frequência que módulo contratado).

**Painel Master** — `admin/feature-flags.html` (nova página + entrada na sidebar): listar flags, criar, mudar status/rollout, adicionar/remover exceção por organização (dropdown com todas as orgs), arquivar. Mesmo padrão de `admin/platform-operators.html` (auth guard, tabela, modais Bootstrap).

**Achado real durante a validação — SLA de propagação, não bug de lógica**: `invalidateCache()` (chamado por toda mutação) só limpa o cache da **instância de processo** que executou a escrita — cada Cloud Function exportada roda em containers separados mesmo compartilhando `index.js`, sem memória compartilhada entre elas. Confirmado empiricamente no deploy desta fase: `setFeatureFlagStatus` mudando uma flag e `resolveFeatureFlags` (instância própria, já quente) ainda devolvendo o valor antigo por alguns segundos. `CACHE_TTL_MS` (20s, `lib/features.js`) **é o SLA real de propagação de um kill-switch**, não uma otimização cosmética — documentado extensivamente no código pra nunca ser reintroduzido como surpresa. Testado ponta a ponta com uma conta `platformAdmins` descartável (criada, testada, apagada — nunca a conta owner real) contra as 5 Cloud Functions já em produção.

### Testes

`functions/test/features.test.js` (26 verificações): `resolveFlag`/`isInRolloutBucket` puros (override vence status, kill-switch por tenant, `environments`, fail-closed) + `createFeatureService` contra o emulador real (ciclo completo create→status→override→archive, idempotência de `createFlag` por chave duplicada, validação de `rolloutPercentage`). Suíte completa: **219 verificações, 0 falhas** (166 unidade/integração — incluindo as 26 novas, 38 Rules, 15 Storage Rules).

---

## Fase 3.9 — Tenant Resolver por Hostname (G4 resolvido) ✅

Resolve o gap G4 (documentado desde a Fase 3.5, `docs/SAAS_MULTITENANT.md`): um único deployment do CCBMG (GitHub Pages) passa a servir **mais de uma organização**, decidindo qual pelo hostname que serviu a página — sem segundo frontend, sem segundo projeto Firebase, sem `currentOrgId` hardcoded pros dois casos abaixo.

### Domínios ativos

| Hostname | orgId | Como chegou até aqui |
|---|---|---|
| `clubedocavalobonfim.com.br` | `org_bonfim` | Origem real (GitHub Pages) — arquivos servidos diretamente |
| `demo.portalassociativo.com.br` | `org_teste_etapa10` ("Clube dos Associados", tenant Sandbox — Fase 3.7) | Cloudflare Worker fazendo proxy reverso pra `clubedocavalobonfim.com.br` (ver abaixo) |

Ambos registrados em `domains/{hostname}` (Fase 3.5) via `setOrganizationDomains` — nenhum registro novo de mecanismo, só uso do que já existia.

### Limitação confirmada do GitHub Pages (verificada antes de implementar, como pedido)

GitHub Pages associa **um único domínio customizado por repositório** — não existe forma suportada de um mesmo Pages site responder por dois hostnames diferentes (confirmado: [GitHub Community Discussion #22779](https://github.com/orgs/community/discussions/22779), [#30915](https://github.com/orgs/community/discussions/30915)). `clubedocavalobonfim.com.br` resolve direto pros IPs do GitHub Pages (`185.199.10x.153`, `server: GitHub.com`) — sem CDN na frente. `portalassociativo.com.br`, por outro lado, **já está atrás do Cloudflare** (`server: cloudflare`, confirmado via `dig`/headers) — o comentário sobre "cache de 4h do Cloudflare" já registrado na Fase 3.6 é esse mesmo Cloudflare. Isso definiu a solução: em vez de brigar com a limitação do GitHub Pages, usar a infraestrutura de edge **que já existe** (não é uma peça nova no stack) como camada de proxy.

### Arquitetura: Cloudflare Worker como proxy reverso (não um segundo frontend)

```
Browser → demo.portalassociativo.com.br (Cloudflare Worker)
              │  fetch(https://clubedocavalobonfim.com.br + path, preservando path/query)
              ▼
         clubedocavalobonfim.com.br (GitHub Pages — ORIGEM ÚNICA, arquivo idêntico)
```

O Worker é puro proxy — não hospeda nenhum HTML/JS próprio, não sabe nada sobre organizações. `location.hostname`, do ponto de vista do navegador, continua sendo `demo.portalassociativo.com.br` (é ele quem está na barra de endereço — o Worker busca o conteúdo de outro lugar e devolve, o browser nunca é redirecionado). É exatamente esse `location.hostname` que o resolvedor abaixo lê.

**Pacote pronto pra publicar** — `cloudflare-worker-demo-proxy/` (repositório `portal-associativo`): `worker.js` (script do proxy) + `wrangler.toml` (já com `[[routes]] pattern = "demo.portalassociativo.com.br" custom_domain = true` — provisiona DNS + certificado TLS + rota automaticamente no deploy, zero passo manual no dashboard) + `README.md` com o passo a passo. Validado com `wrangler deploy --dry-run` antes de entregar.

**Passo pendente (fora do que Claude Code consegue provisionar — sem credencial de conta Cloudflare):**
```bash
cd cloudflare-worker-demo-proxy
npx wrangler login     # abre o navegador, só na primeira vez
npx wrangler deploy    # publica o Worker E cria o Custom Domain — DNS/TLS/rota inclusos
```
Depois de ~1-2 min (emissão do certificado): `curl -I https://demo.portalassociativo.com.br/login.html` deve devolver `200`.

Depois disso, **nenhum outro passo de infraestrutura** é necessário — a resolução de organização já está pronta do lado do código (ver abaixo) e já foi validada contra produção.

### Tenant Resolver — `shared/core/tenant/tenant-context.js`

`getTenant({db})` (Portal Associativo, único consumidor real é `firebase.js` do CCBMG — confirmado por varredura nos dois repositórios antes de mexer) passou a consultar `domains/{location.hostname}` de verdade, não só documentar a intenção como antes da Fase 3.9:

1. `domains/{location.hostname}` no Firestore — cacheado em `sessionStorage` por 1h (mapeamento muda raríssimo).
2. Ausente/erro → ~~cai pro `orgId` estático de `tenant.config.js`~~ **(revisado na Fase 3.10 — ver abaixo: sem fallback nenhum, hostname não cadastrado nunca mais resolve organização nenhuma, nem a estática).**

Um hostname registrado **sempre vence** qualquer config estática — é isso que permite o mesmo `tenant.config.js` (que, desde a Fase 3.10, nem declara `orgId` mais) ser servido atrás de dois hostnames diferentes resolvendo pra organizações diferentes.

`firebase.js` (CCBMG) mudou a ordem de inicialização: `initTenantFirebase()` (config do SDK, igual pra qualquer organização) roda **antes** de `getTenant({db})`, porque a consulta a `domains/` precisa de `db` já pronto. `currentOrgId` virou `const currentOrgId = (await getTenant({db})).orgId` — **top-level await**, seguro porque toda página já importa `firebase.js` via `<script type="module">` (a cadeia de import inteira espera a resolução terminar antes de qualquer código de página rodar — nenhum consumidor de `currentOrgId` precisou mudar, confirmado por varredura nas 28 páginas que o importam).

### Validação (antes de qualquer deploy — lição já aplicada nas fases anteriores)

Testado ponta a ponta com Playwright interceptando requests pro hostname real e servindo os arquivos locais (não alterou `/etc/hosts`, não precisou de DNS) — `location.hostname` genuíno, consulta batendo na produção de verdade:

| Hostname testado | `currentOrgId` resolvido | Resultado |
|---|---|---|
| `clubedocavalobonfim.com.br` | `org_bonfim` | ✅ via `domains/` |
| hostname não cadastrado (qualquer um) | `org_bonfim` (fallback, comportamento da Fase 3.9) | ✅ na época — **substituído na Fase 3.10, ver abaixo** |
| `demo.portalassociativo.com.br` | `org_teste_etapa10` | ✅ via `domains/` |

### Genérico para o futuro

Adicionar um domínio próprio pra uma organização nova (cliente piloto com domínio dele, por exemplo) não exige nenhuma mudança de código daqui pra frente — só: `setOrganizationDomains({orgId, dominioPrincipal})` (já existe, Fase 3.5) + registrar o mesmo Custom Domain no Worker já criado (passo 2 acima, reaproveitando o mesmo Worker — nenhum código novo).

### Arquivos alterados

`shared/core/tenant/tenant-context.js` (Portal Associativo — resolução por hostname), `firebase.js` (CCBMG — reordena init, `currentOrgId` top-level await, bump `?v=2026.08.8` no import de `tenant-context.js` — cache de 4h do Cloudflare exige isso, mesma lição da Fase 3.6).

---

## Fase 3.10 — Tenant Resolver: sem fallback + Gestão de Domínios ✅

Fecha duas lacunas da Fase 3.9: o fallback pro `orgId` estático mascarava erro de DNS/configuração (podia servir a organização errada silenciosamente pra um hostname mal configurado), e a manutenção de `domains/` dependia de entrar em `organization-detail.html` organização por organização — sem visão global, sem busca.

### Decisão 1 — sem fallback automático, pra ninguém

`getTenant({db})` (`shared/core/tenant/tenant-context.js`) não cai mais pro `orgId` de `tenant.config.js` quando o hostname não está em `domains/`. `tenant.config.js` nem declara `orgId` mais — só a config do SDK do Firebase (igual pra qualquer organização). `db` passou de opcional pra **obrigatório** em `getTenant()` (não tem mais pra onde cair sem ele).

```
Hostname em domains/{hostname}?
  SIM → resolve orgId normalmente, aplicação inicia
  NÃO → TenantNotFoundError → renderTenantNotFoundPage() → página amigável, execução interrompida
```

`TenantNotFoundError` (nova classe exportada de `tenant-context.js`) é o sinal distinguível — quem chama decide o que fazer com ele; `renderTenantNotFoundPage(err)` é o comportamento padrão que `firebase.js` usa: substitui **todo** o `<body>` por uma mensagem central ("Organização não encontrada", hostname que falhou, orientação pra quem for administrador da plataforma) — sem CSS/branding externo (não dá pra aplicar branding de uma organização que não foi resolvida), depois relança o erro pra interromper a avaliação do módulo (nenhum script de página específica roda depois — ver comentário em `firebase.js`).

**Sem exceção pro Sandbox nem pra nenhum caso** — o mesmo mecanismo vale pra `clubedocavalobonfim.com.br`, `demo.portalassociativo.com.br` e qualquer domínio futuro. Validado com Playwright (interceptação de hostname real, produção de verdade): hostname cadastrado resolve certo, hostname não cadastrado mostra a página amigável — nunca mais o fallback.

### Decisão 2 — Gestão de Domínios reaproveita a Cloud Function existente, não cria CRUD paralelo

`admin/domains.html` (novo, nav "Domínios" no Painel Master) é a primeira visão **global/cross-organização** de `domains/` — lista todos os hostnames com a organização dona (join com `organizations`), tipo (Principal/Alternativo), status, busca client-side por hostname ou nome da organização.

**Por que não criar `createDomain`/`updateDomain`/`deleteDomain` granulares**: `setOrganizationDomains({orgId, dominioPrincipal, dominiosAlternativos})` (Fase 3.5) já modela "o conjunto de domínios de uma organização" como substituição atômica (garante unicidade global, mirror em `organizations/{orgId}.dominio`, auditoria) — exatamente o mesmo modelo que `organization-detail.html` já usa há uma fase inteira. Criar callables por-domínio duplicaria essa lógica de validação/auditoria em dois lugares. Em vez disso, `domains.html`:
- **Listar**: leitura direta de `domains`/`organizations` (Firestore Rules já permitem `isPlatformStaff()` listar — nenhuma mudança de Rules necessária).
- **Criar/promover a principal**: modal "Novo domínio" — escolhe organização + hostname + tipo; a tela busca o conjunto atual da organização, calcula o conjunto desejado (adiciona como alternativo, ou promove a principal empurrando o anterior pra alternativo) e chama `setOrganizationDomains` — mesma Cloud Function, mesma validação de duplicidade (`already-exists`, mensagem já existente) e de organização inexistente (dropdown só lista organizações reais — impossível selecionar uma que não existe).
- **Remover** (só domínios alternativos, direto da lista — um clique): recalcula o conjunto da organização sem aquele hostname e chama `setOrganizationDomains`. Remover um domínio **principal** não tem atalho de um clique de propósito — expulsar o domínio que resolve a organização é uma mudança grande o bastante pra exigir passar por `organization-detail.html` (onde dá pra escolher explicitamente o novo principal), não um "Remover" impensado numa lista.
- **Editar**: "Ver organização" leva direto pra `organization-detail.html?id={orgId}` (aba Geral, onde o editor completo de domínios já existe desde a Fase 3.5) — zero duplicação de formulário.

`domains` continua sendo **só o resolvedor de hostname** (nenhum campo novo, nenhuma mudança de schema) — `organizations` continua sendo a fonte oficial de quem é a organização. Validado com Playwright autenticado como Platform Owner contra produção: listagem com nomes corretos, busca, adicionar domínio alternativo via UI, remover via UI — ciclo completo, sem deixar resíduo.

### Fluxo completo (hostname → aplicação)

```
1. Browser resolve DNS de demo.portalassociativo.com.br → Cloudflare
2. Cloudflare Worker recebe a request, faz fetch(clubedocavalobonfim.com.br + path)
   e devolve a resposta verbatim — location.hostname no browser continua
   sendo demo.portalassociativo.com.br (nunca há redirect)
3. Frontend carrega (mesmo HTML/JS de sempre — tenant.config.js só tem a
   config do SDK, sem orgId)
4. firebase.js: initTenantFirebase() (config do SDK) → db pronto
5. firebase.js: await getTenant({db}) — tenant-context.js consulta
   domains/{location.hostname} no Firestore (cacheado 1h em sessionStorage)
6a. Encontrado → orgId resolvido → currentOrgId exportado → app roda normal
6b. Não encontrado → TenantNotFoundError → renderTenantNotFoundPage() →
    "Organização não encontrada" → execução interrompida
```

### Tratamento de erros

| Cenário | Onde é pego | Comportamento |
|---|---|---|
| Hostname sem registro em `domains/` | `getTenant()` → `TenantNotFoundError` | Página amigável, sem fallback |
| Domínio duplicado (já é de outra org) | `setOrganizationDomains` (`already-exists`) | Mensagem clara na tela (`domains.html` e `organization-detail.html`) |
| Domínio vazio/inválido | `setOrganizationDomains` (`invalid-argument`, `isValidHostname`) | Mensagem clara na tela |
| Organização inexistente | `setOrganizationDomains` (`not-found`) — na prática inatingível pela UI, dropdown só lista organizações reais | Mensagem clara se atingido via chamada direta à Cloud Function |
| Firestore inacessível durante a consulta a `domains/` | `getTenant()` deixa o erro propagar (sem try/catch silencioso) | Página quebra visivelmente em vez de mascarar — deliberado, mesmo raciocínio da Decisão 1: melhor falha visível que organização errada silenciosa |

### Operação

**Publicar um domínio novo pra uma organização já existente**: Painel Master → Domínios → Novo domínio → escolher organização + hostname + tipo → Cadastrar. Se o domínio for servido por um novo hostname físico (não só um path), configurar DNS/Cloudflare Worker separadamente (ver Fase 3.9 pros passos exatos do Worker) — o cadastro em `domains/` sozinho não cria infraestrutura de rede, só ensina o Tenant Resolver a reconhecer o hostname.

**Criar um novo ambiente de demonstração** (mesmo padrão do Sandbox): 1) organização já provisionada (`provisionOrganization`, Fase 3.3); 2) adicionar Custom Domain no Worker do Cloudflare já existente (Fase 3.9); 3) Painel Master → Domínios → Novo domínio, apontando o hostname pra essa organização.

**Adicionar domínio de cliente futuramente**: idêntico ao passo anterior — nenhuma mudança de código, nenhuma exceção específica. É exatamente o que "genérico pra qualquer organização futura" significa aqui.

**Remover um domínio**: Painel Master → Domínios → localizar a linha → Remover (alternativos) ou "Ver organização" → editar/remover o principal pela aba Geral.

### Arquivos alterados/criados

`shared/core/tenant/tenant-context.js` (sem fallback, `TenantNotFoundError`, `renderTenantNotFoundPage`), `firebase.js` (trata o erro, bump `?v=2026.08.9`), `tenant.config.js` (remove `orgId`), `admin/domains.html` (novo), `admin/assets/admin-nav.js` (item "Domínios").

---

## Fase 3.11 — Auditoria White Label ✅

Varredura completa (frontend das 47 páginas do CCBMG, backend de `functions/index.js`, dados do Firestore) atrás de qualquer referência hardcoded a "Clube do Cavalo"/"CCBMG"/"Bonfim" que vazasse pro tenant Sandbox. ~688 ocorrências brutas encontradas; classificadas em 3 categorias e corrigidas seguindo essa classificação — nenhuma solução específica pro Sandbox, tudo via mecanismo genérico reaproveitável por qualquer organização futura.

### Categoria 1 — Resolvido pelo Tenant Context (o grosso do trabalho)

- **`[data-tenant-name]`/`[data-tenant-logo]`**: existiam só no navbar de 7 páginas. Estendido (transformação em lote, ~161 mudanças) pra navbar **e** rodapé (logo, nome, linha de copyright) de todas as 41 páginas relevantes.
- **`[data-tenant-email]`/`[data-tenant-address]`** (novos): `organizations/{orgId}/public/branding` ganhou `telefone`/`email`/`site`/`endereco` (não existiam na projeção — só `nome`/`logo`/cores) porque páginas públicas (`index.html`, `board.html`, `sobre.html`) precisam ler contato institucional **sem login**. Não é dado sensível (mesmo raciocínio do resto da projeção — ver teste "CRÍTICO" em `organization-public-sync.test.js`).
- **`<title>` dinâmico**: cada página agora declara só o propósito em `<body data-page-title="Login">` (nunca o nome da organização) — `branding.js` monta `"{propósito} — {nome da org}"` em runtime. 37 páginas migradas.
- **Favicon**: `applyBranding()` já trocava o favicon, mas só o primeiro `<link rel="icon">` — páginas com `rel="icon"` E `rel="shortcut icon"` (a maioria) deixavam o segundo com o ícone antigo. Corrigido pra atualizar todos.
- **Nome da organização em textos gerados por JS**: `getOrgBranding()` (já existia, Fase 3.5) passou a ser usado em `admin_associados.html`/`admin_inscricoes.html` pra montar mensagem de WhatsApp de cobrança, assunto de e-mail, cabeçalho/nome de PDF exportado — nada mais hardcoded pra "Clube do Cavalo".
- **URLs absolutas hardcoded** (bug funcional, não só estético): link de redefinição de senha via SMS (`admin_associados.html`) e link de compartilhamento de lote de leilão (`meus_lotes.html`) apontavam pra `https://clubedocavalobonfim.com.br` fixo — um associado do Sandbox receberia um link pro site errado. Trocado por `location.origin`.
- **Backend (`functions/index.js`)**: `from` de e-mail (relatório diário, notificações admin, convite de conta) trocado do endereço fixo `contato@clubedocavalobonfim.com.br` pro endereço realmente autenticado no transporter (`emailUser, do secret) — mais correto tecnicamente (Gmail/SPF já ignorava o override mesmo) e resolve a branding de quebra. Descrição de cobrança no Asaas ("Mensalidade CCBMG") agora interpola `organizationResolver.getOrganization(orgId).nome`.
- **`organizations/{orgId}.notificationEmails`**: condição mudou de "array não-vazio" pra "array presente" — uma organização pode agora configurar explicitamente "nenhum destinatário" (array vazio) sem cair no fallback de e-mails pessoais. **Risco mitigado**: `org_bonfim` (produção real) nunca teve esse campo configurado e dependia do fallback hardcoded pra receber os relatórios de verdade — gravado explicitamente antes da mudança de código pra zero regressão. `org_teste_etapa10` recebeu `notificationEmails: []` (sem ruído de dados fictícios em inbox real).
- **`cms_about`/`cms_board`/`cms_gallery`** (descoberta durante a auditoria, não nova): `board.html`/`gallery.html`/`sobre.html`/`events.html` **já eram** dirigidos por CMS por-organização — o conteúdo do CCBMG que a auditoria encontrou hardcoded era só o *fallback estático* mostrado antes dos dados carregarem, escondido automaticamente (`el.style.display="none"`) assim que a query do Firestore volta com resultado. Sandbox não tinha nenhum documento nessas coleções — por isso o fallback (conteúdo real do CCBMG) aparecia. Corrigido populando `cms_about`/`cms_board` (4 membros fictícios)/`cms_gallery` (1 álbum, 3 fotos) pro Sandbox — **zero mudança de código**, só dado, reaproveitando exatamente o mesmo mecanismo que já existia (`admin_sobre.html`/`admin_diretoria.html`/`admin_galeria.html`).

### Categoria 2 — Substituído por conteúdo genérico

- Placeholders de formulário do Painel Master (`admin_master_associacoes.html`, `admin_master_configuracoes.html`, `portal-associativo/admin/organization-provision.html`) que usavam "Clube do Cavalo Bonfim MG"/"org_bonfim"/"Bonfim" como exemplo — trocados por texto genérico ("Ex: Nome da Organização", "org_slug", "Sua Cidade").
- Prefixo "CCBMG" em assunto de e-mail de notificação administrativa (auto-cancelamento/reativação, redefinição de senha via SMS) — trocado por `[Portal Associativo]`.
- `admin_master.html`/`admin_leiloes.html`: título dizia "SaaS CCBMG"/"Admin CCBMG" (conflava o nome da plataforma com um cliente específico) — corrigido pra "Portal Associativo"/"Admin" genérico.
- CTA decorativo em `sobre.html` ("Faça parte do Clube do Cavalo") — texto genérico, não precisa de interpolação dinâmica pra fazer sentido em qualquer organização.

### Categoria 3 — Existe só como dado do CCBMG (`org_bonfim`)

Conteúdo que é *de verdade* do CCBMG (fotos reais de diretoria pré-Fase-3.11 — hoje substituídas pelo mecanismo CMS acima —, endereço físico real "Antiga Escola Melo Viana", documento "Estatuto Social" real) não precisa de tradução nenhuma: ou já é dado tenant-scoped (CMS) ou foi coberto por **`[data-hide-if-sandbox]`** (novo, `branding.js`) — esconde bloco estático sem equivalente de CMS ainda (o card "Onde Estamos" com endereço/mapa em `index.html`/`board.html`, a seção "Documentos"/Estatuto em `sobre.html`), mostrando um `[data-hide-if-sandbox-fallback]` genérico no lugar quando existe. Gate por `organizations/{orgId}.isSandbox` (Fase 3.7, agora também na projeção pública) — nunca por orgId — genérico pra qualquer tenant de demonstração futuro.

### Testes e validação

`functions/test/organization-public-sync.test.js` estendido (telefone/email/site/endereco/isSandbox na projeção, incluindo o caso "documento sem o campo nunca é tratado como Sandbox por acidente"). Suíte completa: 225 verificações, 0 falhas. Todos os 41 arquivos HTML com script inline validados sintaticamente (`node --check`) antes do deploy — lição das fases anteriores aplicada de novo.

### Pendências (decisão de negócio, não técnica)

- `assets/img/logo_CCBMG.png` continua sendo o favicon/logo **estático de fallback** em todo HTML (só é sobrescrito em runtime se `logoUrl` da organização existir) — funcionalmente correto, mas o nome do arquivo em si é CCBMG-específico. Renomear é cosmético (não afeta comportamento), fora do escopo desta auditoria.
- ~~Meta `<meta name="description">`/Open Graph (`og:image`) continuam estáticos~~ — **resolvido num follow-up da mesma fase**: `branding.js` ganhou `meta[property="og:image"]` (sobrescrito sempre que `logoUrl` existe) e `meta[name="description"]` (via `data-desc-template` em `<body>`, mesmo padrão de `data-page-title`, placeholder `{org}`) — 11 páginas públicas migradas.

---

## Fase 3.12 — `login_master.html`/`admin_master*.html`: mecanismo legado, não uma segunda tela de admin ✅

Investigação disparada por um relato real: as contas Master/Admin do Sandbox (`sandbox_master_01`/`sandbox_admin_01`, Fase 3.7) foram documentadas desde a criação como "login por `login_master.html`, e-mail, não CPF" — mas isso nunca funcionou de verdade pra Admin, só coincidentemente pareceria funcionar pra Master.

### O que `login_master.html`/`admin_master.html` realmente são

Não é uma segunda forma legítima de logar como admin de organização — é um mecanismo **anterior à existência do Painel Master** (o Portal Associativo, repositório separado, Fase 3.1/3.2). Evidência direta no código:
- `login_master.html` lê `users/{uid}.role` e só aceita **`"master"` exato** (`role !== "master"` bloqueia até um `"Admin"` legítimo) — nunca reconheceu `admin`/`operador`/`Admin View`.
- Redireciona pra `admin_master.html`, que consulta `organizations` **sem filtro de orgId** — um dashboard cross-tenant, não o painel de conteúdo de uma organização específica.
- A mesma família (`admin_master_associacoes.html`, `admin_master_configuracoes.html`, `admin_master_faturamento.html`) segue o mesmo padrão: `requiredRole:"master"` exato + consulta `organizations` inteira.

Ou seja: é a versão **pré-multi-tenant** do que a Fase 3.1/3.2 reconstruiu do zero como o Painel Master (`portal-associativo/admin/*.html`, autorização via `platformAdmins`) — nunca foi atualizado nem removido quando o Painel Master de verdade nasceu num repositório separado. Consequência prática hoje: como `migratePlatformAdmins` (Fase 3.2) neutralizou toda conta `role==="master"` legada em `users/{uid}` (virou `"migrado_para_platform_admins"`, nunca apagada — ver Fase 3.2), **nenhuma organização real tem hoje um usuário que passe nesse gate** — inclusive o próprio CCBMG. É código morto, não uma segunda tela concorrente à `admin.html`.

### O mecanismo correto (sempre foi este, documentado desde o início do arquivo)

Master/Admin de uma organização são só usuários normais de `users/{uid}` com `role` elevado — logam pela **mesma** `login.html` (CPF) que qualquer associado. `setupAdminButton()` (`firebase.js`) mostra o botão "Administração" pra quem tem `role` em `["Admin","Master","admin","master","Admin View","adminView"]` (mesma lista que `admin.html` aceita em `requireAuth`), levando pra `admin.html` — o painel real de conteúdo (associados, eventos, galeria, diretoria, produtos, serviços, classificados), sempre escopado pela própria organização via `currentOrgId`.

### Correção aplicada — contas do Sandbox

`sandbox_master_01`/`sandbox_admin_01` foram criadas na Fase 3.7 com e-mail `@sandbox.invalid` (deliberado, pra não disparar `onNewAssociadoCriado` — ver Fase 3.7) e nunca tiveram CPF. Corrigido pra usar o mecanismo real:
- `users/sandbox_admin_01.cpf` = `11122233043`, `users/sandbox_master_01.cpf` = `22233344073` (checksum válido, nunca colide com os 35 CPFs de associados já seedados).
- E-mail da conta no Firebase Auth (não o `users/{uid}.email`, o e-mail de login de verdade) atualizado pra `{cpf}@cpf.local`, mesma convenção de qualquer associado — sem isso, o `cpf` no Firestore sozinho não teria efeito nenhum (`login.html` monta o e-mail de login a partir do CPF digitado; precisa bater com o e-mail real da conta).
- **Sem efeito colateral no Asaas**: confirmado antes de aplicar — `onNewAssociadoCriado` só dispara em `onCreate` (contas já existem, não refaz); `onAssociadoAtualizado` (`onUpdate`) sai no primeiro `if (!after.asaasId) return null;` — nenhuma das duas contas tem `asaasId`, então a mudança de `cpf` via `update` não aciona sincronização nenhuma com o Asaas.
- Validado ponta a ponta: login via `login.html` com o CPF novo → botão "Administração" aparece → `admin.html` carrega normalmente, escopado a "Clube dos Associados".

### Follow-up — só 1 Admin, perfil copiado de uma pessoa real (com cuidado)

Pedido do operador: reduzir de 2 contas `Admin` pra 1 só, com nome/apelido/telefone copiados do perfil de uma associada real do CCBMG (identificada por CPF). **Achado antes de agir**: esse CPF pertence a uma associada real, paga, ativa em `org_bonfim` (produção) — copiar o CPF literal teria exigido mudar o `orgId` do documento dela, o que quebraria o acesso dela à própria conta real (Auth/e-mail são globais no projeto — um CPF só pode apontar pra um `orgId`). Confirmado com o operador antes de agir; decisão: copiar só os campos de identificação pessoal (nome, apelido, telefone) pra um CPF **sintético** novo, nunca o CPF real — a conta real dela em `org_bonfim` nunca foi tocada.

- `sandbox_admin_02` (segunda conta Admin) excluída por completo — Firestore + Auth (mesma classe de operação de `deleteAssociado`).
- `sandbox_admin_01` passou a ter `nome`/`apelido`/`telefone` copiados (só esses campos — nunca `asaasId`/`planType`/dados de billing, que não fazem sentido numa conta administrativa e nunca devem cruzar de um associado real pra uma conta do Sandbox); `cpf` continua o sintético já atribuído acima.
- `functions/scripts/seedSandboxTenant.js` (`TEAM`) atualizado pra refletir esse estado como o padrão daqui pra frente — sem isso, rodar o Seed Oficial de novo recriaria a 2ª conta Admin e desfaria a mudança silenciosamente. Novo helper `ensureAuthUserEmail()` converge o e-mail de uma conta Auth pré-existente (idempotente) — necessário porque `ensureAuthUser()` sozinho nunca atualiza e-mail de conta já criada.
- **Achado colateral, não relacionado à mudança em si**: durante a verificação ponta a ponta, o login parou de funcionar entre um teste e outro sem nenhuma ação intencional no meio — `passwordUpdatedAt` da conta mostrou uma mudança de senha ~12s depois do login anterior, coincidindo com um teste automatizado anterior que navegou e clicou dentro de `pg_associado.html` (não `admin.html` diretamente). Causa raiz não identificada com certeza (não é `primeiroAcesso`, que já estava `false`) — mitigado resetando a senha de volta pro padrão documentado. Registrado aqui como ponto de atenção pra quem for testar esse fluxo de novo: prefira navegação direta por URL a cliques dentro de `pg_associado.html` até a causa ser entendida.

### Pendência (decisão de negócio, não técnica)

`login_master.html`/`admin_master.html`/`admin_master_associacoes.html`/`admin_master_configuracoes.html`/`admin_master_faturamento.html` são candidatos a remoção (código morto — nenhuma organização real consegue mais passar pelo gate `role==="master"` exato desde a Fase 3.2). Não removidos nesta fase: há referências em `docs/DEMO.md` (corrigida aqui), em `tests/e2e/*.spec.js` (múltiplos arquivos) e em `functions/scripts/seedSandboxTenant.js` — remover exige atualizar/remover os testes e2e correspondentes também, decisão maior o suficiente pra ficar de fora de uma correção pontual.

---

## Fase 4 — Evolução Multi-Tenant: Configurações Personalizáveis por Tenant ✅

Baseline: auditoria de hard-codes de negócio (`portal-associativo/docs/roadmap/TENANT_HARDCODE_AUDIT_REPORT.md`) encontrou o motor de cobrança inteiro (preços/ciclos/desconto Mirim/juros), regras de leilão/classificados/carência, e vários pontos de contato (WhatsApp/Instagram/endereço) ainda como constante de módulo compartilhada por toda a plataforma, em vez de configuração por organização. Esta fase resolveu isso — relatório completo em `portal-associativo/docs/roadmap/EVOLUCAO_MULTITENANT_FASE4_REPORT.md`.

### Schema novo — `organizations/{orgId}`

```
billing.plans[]                        — [{id,label,cycle,price}], substitui PLAN_CYCLE/PLAN_VALUE/PLAN_LABEL
billing.mirimDiscountRatio             — fração do preço que Mirim paga (0.5 = metade); ausente = 1 (sem desconto)
billing.lateInterestRate               — juros de atraso repassado ao Asaas; ausente = 0

business.membership.renewSoonDays      — dias antes do vencimento pra avisar renovação
business.membership.graceOverdueDays   — dias de carência antes de bloquear o portal

business.classifieds.pricePerDay       — preço/dia de anúncio em Classificados
business.classifieds.minimumDays       — prazo mínimo/duração do anúncio

business.auction.minBidIncrementPct    — incremento mínimo entre lances
business.auction.antiSniperExtensionMs — extensão quando um lance chega perto do fim
business.auction.commissionClubePct    — comissão da ASSOCIAÇÃO, editável pelo próprio Master
business.auction.commissionSistemaPct  — comissão da PLATAFORMA — só Platform Administrator escreve,
                                          bloqueado nas Firestore Rules mesmo dentro do mesmo documento
                                          que o Master já pode editar (comparação de valor, não de chave)
```

`whatsapp` (já existia desde a Fase 3.4) e `portal.redesSociais` (idem) passaram a ter consumidor de verdade: `organizationPublicSync.js` os inclui na projeção pública (`organizations/{orgId}/public/branding`), e `shared/core/tenant/branding.js` aplica via `[data-tenant-whatsapp]`/`[data-tenant-whatsapp-label]`/`[data-tenant-social="facebook|instagram|youtube"]`. `notificationEmails` (já lido pelo backend desde a Fase 3.6) passou a ser **obrigatório desde o provisionamento** — o fallback pra e-mail pessoal hardcoded (`waldiney.serafim@gmail.com`/`mpmarquesnutri@gmail.com`) foi removido do código; organização sem o campo configurado simplesmente não envia, nunca vaza PII pra terceiros.

### Autoatendimento — `admin_configuracoes.html` (novo, Portal da Associação)

Primeira tela onde o **Organization Master** administra a própria organização sem depender do Painel Master (equipe da plataforma). `firestore.rules` ganhou `isOrgMasterSelfService(orgId)` — `allow update` em `organizations/{orgId}` passou de `isPlatformAdministrator()` sozinho para `isPlatformAdministrator() || isOrgMasterSelfService(orgId)`, com um allowlist de campos de topo (`nome, nomeCurto, descricao, cnpj, email, site, telefone, whatsapp, cidade, estado, cep, pais, endereco, config, portal, billing, business, notificationEmails, updatedAt` — nunca `billingProvider/billingConfig/modules/ativo/plan/dominio`, que continuam exclusivos do Núcleo) mais uma comparação de valor dedicada que impede a organização de tocar `business.auction.commissionSistemaPct` mesmo escrevendo o resto de `business` livremente. Organization Admin acessa a mesma tela em modo só-leitura (a Rule já bloquearia a escrita; o modo leitura é só UX).

`admin/organization-detail.html`/`organizations.html`/`admin/index.html`/`subscriptions.html` (Painel Master) tinham uma lista fixa de planos SaaS (`starter/professional/enterprise/custom`) mesmo já existindo um editor genérico (`admin/plans.html`, `systemPlans`) desde a Fase 3.1 — as 4 telas passaram a consultar `systemPlans` em runtime.

### Migração dos tenants existentes

`functions/scripts/migrateBusinessConfig.js` (`--dry-run`/`--apply`, mesmo padrão REST+`gcloud auth print-access-token` de `seedSandboxTenant.js`) populou `org_bonfim` e `org_teste_etapa10` com os valores que o código hardcoded já usava (nenhum valor comercial mudou, só passou a ser dado da organização). Achado durante a migração: **`notificationEmails` não existia de verdade em produção** pra nenhum dos dois tenants (confirmado por leitura direta do Firestore) — ao contrário do que a Fase 3.11 registrava. Corrigido na própria migração, preservando os destinatários reais do CCBMG.

### Testes

219 → **239 verificações, 0 falhas** (178 unidade/integração + 46 Rules, incluindo 8 novas provando a fronteira do self-service — Master edita a própria org, Admin não pode, Master de outra org não pode, campos fora do allowlist são rejeitados, `commissionSistemaPct` é intocável mesmo dentro do próprio payload de `business.auction` — + 15 Storage Rules).

### Pendências (fora do escopo desta fase, não lacunas novas)

Conta Asaas/SMTP compartilhada, `billingProvider` fixo no provisionamento, reCAPTCHA site key de um domínio só, timezone fixo em crons, Cloudflare Worker de origem única — todos já eram dívida técnica documentada em fases anteriores (G7, RC1-03/04/05/08) e ficaram deliberadamente fora do escopo desta fase (que tratou só de configuração de negócio, não de infraestrutura/secrets). Identidade visual e localização continuam só no Painel Master — não foram estendidas ao autoatendimento por não terem sido flagadas como hardcoded pela auditoria (já eram 100% dinâmicas desde a Fase 3.4/3.5).

---

## Integração Asaas ✅ (Fase 2 — LIVE)

**API:** `https://api.asaas.com/v3`
**Segredos no Secret Manager:**
- `projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest` — chave da API
- `projects/clubecavalobonfim/secrets/asaas-webhook-token/versions/latest` — token de autenticação do webhook (associados)
- `projects/clubecavalobonfim/secrets/asaas-auction-webhook-token/versions/latest` — token de autenticação do webhook do módulo de leilões (`auctionAsaasWebhook`, secret distinto do webhook de associados)

### Planos e valores
| planType | Ciclo Asaas | Valor |
|----------|-------------|-------|
| mensal | MONTHLY | R$ 30 |
| trimestral | QUARTERLY | R$ 85 |
| semestral | SEMIANNUALLY | R$ 170 |

### Cloud Functions — Asaas

| Função | Tipo | Descrição |
|--------|------|-----------|
| `onNewAssociadoCriado` | Firestore onCreate `users/{uid}` | Cria cliente + assinatura no Asaas automaticamente |
| `onAssociadoAtualizado` | Firestore onUpdate `users/{uid}` | Sincroniza nome/telefone/CPF para o Asaas quando alterados; quando `ativo` muda `true→false`, pausa a assinatura, cancela cobranças `PENDING`/`OVERDUE` em aberto e desliga notificações; quando muda `false→true`, reativa a assinatura, religa notificações e gera uma cobrança avulsa imediata |
| `onInvoicePaid` | Firestore onUpdate `users/{uid}/financeInvoices/{id}` | Baixa cobrança no Asaas quando admin marca fatura como paga |
| `onInvoiceCreatedPaid` | Firestore onCreate `users/{uid}/financeInvoices/{id}` | Idem para faturas criadas diretamente como pagas |
| `asaasWebhook` | HTTP público | Recebe PAYMENT_RECEIVED/CONFIRMED do Asaas → atualiza fatura + finance/summary |
| `configureAsaasNotifications` | HTTP Callable | Configura 3 avisos SMS por assinatura (−5d, 0, +5d) |
| `syncAllAssociadosToAsaas` | HTTP Callable | Migração em massa (uso pontual) |
| `createAsaasSubscriptions` | HTTP Callable | Criação em massa de assinaturas (uso pontual) |
| `deleteAssociado` | HTTP Callable (master) | Exclui associado (Firestore + Auth) e cancela cliente/assinatura no Asaas |
| `cancelMySubscription` | HTTP Callable (self-service) | Associado confirma CPF+telefone e cancela a própria assinatura — fala direto com o Asaas (pausa assinatura, cancela cobranças em aberto, desliga notificações) e grava `assinaturaCanceladaPeloAssociado:true`, **sem** tocar em `ativo` (ver Autocancelamento); avisa admins por e-mail |
| `reactivateMySubscription` | HTTP Callable (self-service) | Associado reverte um autocancelamento (reativa assinatura, religa notificações, gera cobrança avulsa) — bloqueado se a conta tiver sido desativada pelo admin (`ativo:false`) |

**Webhook URL:**
`https://us-central1-clubecavalobonfim.cloudfunctions.net/asaasWebhook`
Configurado no Asaas: Configurações → Integrações → Webhook
Eventos: `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`
Validação: header `asaas-access-token` comparado ao secret no Secret Manager

### Lógica do webhook
1. Valida token de autenticação
2. Verifica pagamento diretamente na API Asaas (anti-fraude)
3. Busca assinatura pelo `payment.subscription` → obtém `externalReference` (Firebase UID)
4. Checa idempotência por `asaasPaymentId` nas `financeInvoices`
5. Busca fatura `em_aberto`/`atrasado`/`vencido` com a mesma `dueDate` e **atualiza** (não cria duplicata)
6. Se não encontrar fatura existente, cria nova
7. Chama `updateFinanceSummary(uid)` para atualizar `finance/summary`

### Sincronização bidirecional
- **Firebase → Asaas:** triggers automáticos em create/update de usuários e faturas
- **Asaas → Firebase:** webhook HTTP público com validação de token e idempotência
- Evita loop: `onAssociadoAtualizado` só dispara se `nome`/`telefone`/`cpf` mudaram; webhook só cria/atualiza `financeInvoices` (subcoleção), não o documento do usuário

### Campos no Asaas
- Criado com: `name`, `cpfCnpj`, `mobilePhone` (11 dígitos sem prefixo 55), `externalReference` (UID Firebase)
- Assinatura: `billingType: UNDEFINED` (associado escolhe PIX/boleto/cartão), `interest: {value: 0.01}`, `notificationEnabled: true`
- Notificações SMS: −5 dias, no vencimento, +5 dias

### Autocancelamento pelo associado
- Botão "Cancelar assinatura" em `pg_associado.html` (área logada) abre modal de 2 passos: confirma CPF+telefone cadastrados, depois mostra até quando o plano pago continua valendo (`finance/summary.activeUntil`) e pede confirmação explícita.
- Chama `cancelMySubscription` (Cloud Function), que só age sobre `context.auth.uid` — nunca aceita uid do payload.
- **Não grava `ativo:false`.** `ativo:false` é o mecanismo do admin para desligamento imediato (`admin_associados.html`) e é checado tanto por `login.html` (`routeAuthenticatedUser`/`deriveStatus` — redireciona pra `pay.html` **antes mesmo** de chegar em `pg_associado.html`) quanto por `firebase.js` (`getUserStatus`). Usar `ativo:false` no autocancelamento bloquearia o acesso imediatamente, contrariando o requisito de manter os benefícios até o fim da vigência paga.
- Em vez disso, `cancelMySubscription` fala direto com o Asaas — pausa a assinatura (`POST /subscriptions/{id}` `status:INACTIVE`) e reaproveita `cancelOpenPayments`/`setCustomerNotificationsEnabled` (as mesmas rotinas que `onAssociadoAtualizado` usa na desativação pelo admin) — e grava só `assinaturaCanceladaPeloAssociado:true` + `assinaturaCanceladaEm`. Como cobranças já pagas nunca são tocadas, o associado mantém acesso normal (login + portal) até `activeUntil`; quem efetivamente bloqueia o acesso quando a vigência vence é o gate de inadimplência que já existe em `pg_associado.html` (> `GRACE_OVERDUE_DAYS` dias vencido).
- "Reativar assinatura" chama `reactivateMySubscription`, que reverte isso (reativa assinatura, religa notificações via `syncCustomerNotifications`, gera cobrança avulsa via `createImmediateChargeOnReactivation`) — bloqueado se `ativo === false` (conta desativada pelo admin é um mecanismo totalmente separado, não pode ser revertida pelo associado).
- Admins recebem e-mail imediato (mesmo transporter/credenciais do relatório diário) a cada cancelamento/reativação self-service.

---

## Cloud Function: Relatório Diário

- Arquivo: `functions/index.js`
- Disparo: todo dia às **08:00 BRT** (`0 8 * * *`)
- Agrupa associados em: vence hoje / a vencer em 5 dias / vencido 5–10 dias / vencido +10 dias
- Envia email HTML via **Nodemailer + Gmail** para `waldiney.serafim@gmail.com` e `mpmarquesnutri@gmail.com`
- Credenciais no Secret Manager: `email-user`, `email-password`

---

## Regras de Desenvolvimento

1. Não quebrar funcionalidades existentes — sempre analisar impacto antes de alterar.
2. Usar JavaScript Vanilla (ES Modules). Sem frameworks adicionais.
3. Usar `async/await` consistentemente.
4. Frontend hospedado no GitHub Pages — sem build step, arquivos servidos diretamente.
5. Validar roles admin/master em todas as operações administrativas.
6. Nunca expor secrets em HTML/JS — usar Secret Manager ou variáveis de ambiente nas Functions.
7. Pensar em escalabilidade SaaS (Fase 5 do roadmap).
8. Documentar novas coleções Firestore e integrações neste arquivo.

---

## Roadmap

| Fase | Descrição |
|------|-----------|
| 1 | Portal completo ✅ |
| 2 | Integração Asaas ✅ (assinaturas, webhook, sync bidirecional) |
| 3 | Marketplace |
| 4 | Aplicativo |
| 5 | SaaS Multi-Tenant |
| 6 | IA e automações |

---

## Segurança e LGPD

- Dados pessoais armazenados: nome, CPF, telefone, endereço
- Regras de acesso centralizadas no Firebase (não confiar no frontend)
- Webhook Asaas validado por token no Secret Manager + verificação do pagamento na API
- A implementar: exportação, exclusão e anonimização de dados (LGPD)

---

## Como Agir como Colaborador

Ao propor mudanças, sempre:
1. Explicar impacto e riscos
2. Listar arquivos afetados
3. Propor versão simples e escalável
4. Priorizar baixo custo e compatibilidade com GitHub Pages + Firebase
