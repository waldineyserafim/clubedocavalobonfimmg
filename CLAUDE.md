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
| `migratePlatformAdmins` | uso único — gate é o mecanismo antigo (`role==="master"` em `users/{uid}`, sem passar por organização) | migra toda conta `master` legada pra `platformAdmins` com `role:"owner"`; não apaga o doc antigo, só neutraliza `role` pra `"migrado_para_platform_admins"` (não-destrutivo, idempotente) |

`backfillLeilaoOrgId` (utilitário de migração da Fase 2C) foi reclassificado de `requireOrganizationMaster` para guarda de plataforma — sempre foi, mecanicamente, uma operação cross-org, nunca de autoatendimento de uma organização.

Todas as 3 callables de gestão de equipe gravam auditoria diretamente em `systemLogs` via Admin SDK (atestado pelo servidor) — `platformAdmins` não permite nenhuma escrita direta do cliente (ver Firestore Rules abaixo), então essa é a única fonte de auditoria dessas mutações.

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
