# CCBMG — Claude Code Context

## Organização
**Clube do Cavalo de Bonfim MG (CCBMG)**
Site: https://clubedocavalobonfim.com.br
Repositório: https://github.com/waldineyserafim/clubedocavalobonfimmg
Firebase Project: `clubecavalobonfim`

Este repositório contém **duas coisas ao mesmo tempo**, e é importante não confundi-las:

1. **O tenant CCBMG** — o frontend público/associado/admin deste clube específico (`index.html`, `pg_associado.html`, `admin.html` etc.) e os fatos de negócio do CCBMG (planos, Asaas, relatório diário).
2. **O backend da plataforma inteira** — `functions/` (Cloud Functions), `firestore.rules`, `storage.rules`. Existe **um único** projeto Firebase (`clubecavalobonfim`) compartilhado por todos os tenants da plataforma "Portal Associativo" (hoje: CCBMG em produção + um tenant Sandbox oficial de demonstração) — e todo esse backend mora neste repositório, não em `portal-associativo`.

O repositório irmão `portal-associativo` é a plataforma SaaS como produto: o Painel Master (`admin/*.html` de lá — administração cross-tenant pela equipe da Serafim Technologies), o núcleo de frontend compartilhado (`shared/`, consumido por este repositório via ES Modules cross-origin) e o site institucional/marketing. **`portal-associativo/CLAUDE.md`** é a referência para arquitetura de plataforma (modelo multi-tenant, papéis, Tenant Resolver, White Label, Feature Flags, Painel Master) — este arquivo aqui foca no que é implementação (o código que roda) e no que é específico do CCBMG.

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

### Área Administrativa (requer role admin ou master **da organização**)
- `admin.html` — Painel principal deste tenant (associados, conteúdo, financeiro — sempre escopado a `currentOrgId`)
- `admin_associados.html` — Gestão de associados + financeiro + faturas
- `admin_produtos.html` — Gestão de produtos
- `admin_servicos.html` — Gestão de serviços
- `admin_classificados.html` — Moderação de classificados
- `admin_configuracoes.html` — Autoatendimento do Organization Master (Fase 4, ver resumo abaixo)

> `login_master.html`/`admin_master*.html` — mecanismo **legado, pré-Painel Master**, não uma segunda forma válida de administrar uma organização. Ver resumo da Fase 3.12 abaixo.

### Código Central
- `firebase.js` — Módulo central: auth, resolução de tenant (`getTenant()`, ver Fase 3.9/3.10), Firestore, Storage, helpers de role, upload de imagem com compressão
- `functions/index.js` + `functions/lib/*.js` — **Todas as Cloud Functions da plataforma**: relatório diário + integração Asaas do CCBMG, e também o backend multi-tenant inteiro (`platform.js`, `provisioning.js`, `billing/`, `domains.js`, `features.js`, `organizationPublicSync.js`) consumido por qualquer tenant, inclusive o Sandbox

---

## Firestore Schema

> Este é o schema físico do projeto Firebase compartilhado — vale para qualquer tenant da plataforma, não só CCBMG. As coleções `platformAdmins`/`organizations`/`provisioningRuns`/`domains`/`featureFlags` são conceitos de **plataforma** (modelo completo em `portal-associativo/CLAUDE.md`); estão listadas aqui porque o código que as lê/escreve mora neste repositório.

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

platformAdmins/{uid}  — equipe da Serafim Technologies, NUNCA tem orgId
  role (owner|administrator|operator), nome, email, ativo,
  createdAt, updatedAt, createdBy
  — escrita só via Cloud Functions (Admin SDK); Firestore Rules bloqueiam
  qualquer escrita direta do cliente — modelo completo em portal-associativo/CLAUDE.md

organizations/{orgId}
  provisioningStatus, provisionedAt, provisionedBy,
  billingProvider (string, campo do TOPO — o que getBillingProvider() de verdade lê,
    não confundir com config.billingProvider, que é histórico/cosmético),
  config.{idioma,timezone,moeda,dateFormat,timeFormat,logoUrl,faviconUrl,
    corPrimaria,corSecundaria,notificationsEnabled,fromEmail,fromName},
  nomeCurto, descricao, pais,
  billingEnvironment (sandbox|producao), billingStatus, billingConfig.publicParams,
  portal.redesSociais {facebook,instagram,youtube},
  integrations (mapa vazio por padrão),
  isSandbox, environment, isDemoTenant (Fase 3.7 — só o tenant Sandbox oficial),
  billing.plans[], billing.mirimDiscountRatio, billing.lateInterestRate (Fase 4),
  business.membership.{renewSoonDays,graceOverdueDays},
  business.classifieds.{pricePerDay,minimumDays},
  business.auction.{minBidIncrementPct,antiSniperExtensionMs,commissionClubePct,commissionSistemaPct}
    (Fase 4 — commissionSistemaPct só é editável por Platform Administrator, nunca pelo Master da organização),
  notificationEmails[] (obrigatório desde o provisionamento — Fase 4; sem fallback pra e-mail pessoal)

provisioningRuns/{runId}  — rastreamento/auditoria de provisionOrganization
  orgId, requestedBy, requestedByEmail, planId,
  status (running|completed|failed), startedAt, finishedAt,
  steps: [{name, status: ok|error|skipped, startedAt, finishedAt, error}]
  — escrita só via Cloud Functions

domains/{hostnameNormalizado}  — registro hostname → orgId (Tenant Resolver, ver Fase 3.9/3.10)
  orgId, tipo (primario|alternativo), status (verificado),
  criadoEm, criadoPor, atualizadoEm
  — escrita só via Cloud Function setOrganizationDomains, leitura pública

organizations/{orgId}/public/branding  — projeção pública e curada
  nome, nomeCurto, logoUrl, faviconUrl, corPrimaria, corSecundaria,
  modules, billingProvider, telefone, email, site, endereco, isSandbox, updatedAt
  — mantida por trigger onOrganizationWritten; NUNCA inclui observações/billingConfig/integrations

featureFlags/{flagKey}  — Fase 3.8, plataforma inteira
  key, description, category, status (off|on|rollout), rolloutPercentage,
  overrides: {[orgId]: boolean}, environments, archived,
  createdAt, updatedAt, createdBy, updatedBy
  — leitura direta restrita a isPlatformStaff(); cliente só via callable resolveFeatureFlags
```

---

## Autenticação e Roles

- CPF é convertido para email: `12345678900` → `12345678900@cpf.local`
- Roles de **organização** (`users/{uid}.role`, sempre com `orgId`): `master` (Organization Master) > `admin` (Organization Administrator) > `operador` (Organization Operator) > `Admin View` (Organization Viewer) > `associado`/`participanteLeilao`
- Roles de **plataforma** (`platformAdmins/{uid}`, nunca tem `orgId`): `owner` > `administrator` > `operator` — plano de identidade inteiramente separado das roles de organização (nunca cruza tenant). **Modelo completo (o que cada papel pode, Cloud Functions de gestão de equipe, Firestore Rules) documentado em `portal-associativo/CLAUDE.md`** — aqui só o que é necessário pra entender o código deste repositório.
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

## Evolução da Plataforma Multi-Tenant (Fases 3.2–3.12 + Fase 4)

Todo o mecanismo de plataforma (Painel Master, `platformAdmins`, provisionamento, domínios, Tenant Resolver, White Label, Feature Flags, configuração por organização) foi construído em cima do backend que mora neste repositório, mas é **arquitetura de plataforma**, não fato do tenant CCBMG — por isso os relatórios completos vivem em `portal-associativo/docs/roadmap/`. Resumo de cada fase, com link para o relatório correspondente:

| Fase | O que entregou | Relatório completo |
|---|---|---|
| **3.2** — Administração da Plataforma | Substitui o `master` plano/cross-tenant por dois planos de identidade separados: `platformAdmins` (equipe da plataforma, nunca tem `orgId`) e `users.role` (papel de organização, sempre com `orgId`). 4 Cloud Functions de gestão de equipe (`createPlatformAdmin`, `setPlatformAdminStatus`, `setPlatformAdminRole`, `deletePlatformAdmin`) + `migratePlatformAdmins` (migração única). | `portal-associativo/docs/roadmap/FASE3_2_ADMINISTRACAO_DA_PLATAFORMA_REPORT.md` |
| **3.3** — Provisionamento Automático | `provisionOrganization` (Cloud Function, `functions/lib/provisioning.js`) — mecanismo único e idempotente de criação de tenants: org + primeiro Master + módulos + billing + branding + CMS mínimo, com auditoria por etapa em `provisioningRuns/`. | `portal-associativo/docs/roadmap/FASE3_3_PROVISIONAMENTO_AUTOMATICO_REPORT.md` |
| **3.4** — Configuração por Organização | Central de Configuração (`admin/organization-detail.html`, Painel Master) — 8 categorias reais (Geral, Localização, Identidade Visual, Financeiro, Comunicação, Portal, Integrações, Segurança). `billingEnvironment` (sandbox/produção) conectado de verdade em `getBillingProvider()`. | `portal-associativo/docs/roadmap/FASE3_4_CONFIGURACAO_POR_ORGANIZACAO_REPORT.md` |
| **3.5** — Identidade do Tenant e Domínios | `domains/{hostname}` (registro hostname→orgId) e `organizations/{orgId}/public/branding` (projeção pública curada, mantida por trigger). Consumido por `shared/core/tenant/branding.js` (Portal Associativo) + `firebase.js` (este repositório). | `portal-associativo/docs/roadmap/FASE3_5_IDENTIDADE_DOMINIOS_REPORT.md` |
| **3.6** — Hardening e Go Live Comercial | Auditoria completa que descobriu que nada da Fase 3.2+ tinha sido deployado em produção. Patch crítico independente (auto-cadastro `role:"master"`, vazamento de PII em `eventRegistrations`) + 8 correções de segurança/qualidade + Firestore PITR habilitado. | `portal-associativo/docs/roadmap/FASE3_6_HARDENING_GO_LIVE_REPORT.md` |
| **Deploy Controlado (pós-3.6)** | Fases 3.2–3.6 publicadas em produção: Rules, 44 Cloud Functions, `migratePlatformAdmins` executada (Platform Owner migrado), domínio do CCBMG registrado, backup semanal do Auth, 2 alertas no Cloud Monitoring. Segundo tenant de teste provisionado (`org_teste_etapa10`). | `portal-associativo/docs/roadmap/ETAPA1_DEPLOY_CONTROLADO_FASE3_6_REPORT.md` |
| **Auditoria Final RC1** | Auditoria de prontidão comercial da plataforma inteira. Resultado: **GO WITH CONDITIONS** (P0: 0, P1 aberto: 0, P2: 2, P3: 7). Achado P1 (`startPasswordReset` vazando telefone) corrigido durante a própria auditoria (reCAPTCHA Enterprise + `orgId` obrigatório). | `portal-associativo/docs/roadmap/AUDITORIA_FINAL_RC1_REPORT.md` |
| **3.7** — Tenant Sandbox Oficial | `org_teste_etapa10` ("Clube dos Associados") vira o ambiente permanente de QA/demo da plataforma — identificado só por `isSandbox: true`, nunca por nome. Asaas Sandbox configurado (conta separada, webhook dedicado `asaasSandboxWebhook`). Seed oficial reaproveitável: `functions/scripts/seedSandboxTenant.js`. | `portal-associativo/docs/roadmap/FASE3_7_TENANT_SANDBOX_REPORT.md` |
| **3.8** — Ambiente Local, CI/CD e Feature Flags | Ambiente local 100% funcional (Java pro emulador, `npm run dev/test/lint/build`). CI no GitHub Actions (`lint-and-build` + `test`, sem automatizar deploy). Camada de Feature Flags multi-tenant (`featureFlags/{flagKey}`, resolução fail-closed, `admin/feature-flags.html` no Painel Master). | `portal-associativo/docs/roadmap/FASE3_8_LOCAL_CICD_FEATURE_FLAGS_REPORT.md` |
| **3.9** — Tenant Resolver por Hostname (G4) | Um mesmo deployment (GitHub Pages) passa a servir mais de uma organização, resolvida pelo hostname (`domains/{hostname}`). Segundo hostname (`demo.portalassociativo.com.br`) servido via Cloudflare Worker como proxy reverso (`cloudflare-worker-demo-proxy/`, Portal Associativo) — sem segundo frontend. | `portal-associativo/docs/roadmap/FASE3_9_TENANT_RESOLVER_HOSTNAME_REPORT.md` |
| **3.10** — Tenant Resolver sem fallback + Gestão de Domínios | `getTenant()` para de cair pro `orgId` estático quando o hostname não está cadastrado — hostname desconhecido agora mostra `TenantNotFoundError`/página amigável em vez de servir a organização errada silenciosamente. `admin/domains.html` (Painel Master) — primeira visão global de todos os domínios cadastrados. | `portal-associativo/docs/roadmap/FASE3_10_TENANT_RESOLVER_SEM_FALLBACK_E_DOMINIOS_REPORT.md` |
| **3.11** — Auditoria White Label | Varredura completa (~688 ocorrências) atrás de referências hardcoded a "Clube do Cavalo"/CCBMG que vazariam pro Sandbox. Resolvido majoritariamente via Tenant Context (`[data-tenant-*]`, `<title>`/favicon/meta dinâmicos); resto virou texto genérico ou `[data-hide-if-sandbox]`. | `portal-associativo/docs/roadmap/FASE3_11_AUDITORIA_WHITE_LABEL_REPORT.md` |
| **3.12** — `login_master.html` é mecanismo legado | Confirma que `login_master.html`/`admin_master*.html` são pré-Painel Master e hoje são código morto (nenhuma organização real passa mais pelo gate `role==="master"` exato). Contas do Sandbox corrigidas para usar o mecanismo real (`login.html` por CPF). | `portal-associativo/docs/roadmap/FASE3_12_LOGIN_MASTER_LEGADO_REPORT.md` |
| **4** — Evolução Multi-Tenant (Configuração de Negócio) | Todo hard-code de negócio (preços, ciclos, desconto Mirim, juros, regras de leilão/classificados/carência) migrado para `organizations/{orgId}` (`billing.*`, `business.*`). Nova tela de autoatendimento `admin_configuracoes.html` (Organization Master edita a própria org, com `commissionSistemaPct` protegido nas Rules mesmo pro Master). 239 testes, 0 falhas. | `portal-associativo/docs/roadmap/EVOLUCAO_MULTITENANT_FASE4_REPORT.md` |
| **Prospecção IA** — Agente Autônomo de Prospecção Comercial | Agente autônomo (Claude, Messages API + tool `web_search` server-side) que pesquisa a web semanalmente e alimenta o `leads` existente (Release 2) com organizações candidatas a virar novos tenants — nunca um CRM por organização (decisão de escopo confirmada explicitamente antes de implementar). `prospectingCampaigns`/`prospectingRuns` (novo, mesmo par de Rules de `leads`: `isPlatformAdministrator()` lê, só Cloud Function escreve) + `leadDedupIndex` (auxiliar, nunca lido pelo cliente). Execução em duas Cloud Functions em cadeia: `requestRun` (Gen 1, rápido) reivindica o lock e cria o doc de execução; `executeRun` (Gen 2, até 30min — único desvio do padrão Gen 1 do backend) roda o ciclo de verdade, disparado por trigger do Firestore. Score sempre recalculado em código (nunca confiado ao modelo), nunca sacrifica qualidade pra bater a meta de leads. 263 testes, 0 falhas. | `portal-associativo/docs/roadmap/PROSPECCAO_IA_REPORT.md` |
| **Agente de Outbound** — Abordagem Comercial Assistida por IA | Segundo agente, extensão da Prospecção IA: transforma leads qualificados em abordagens comerciais personalizadas (assunto/mensagem/CTA/evidências), **sem enviar nada automaticamente** — toda abordagem nasce em revisão humana. Reaproveita o MESMO `ClaudeProvider` (`functions/lib/prospecting/claudeProvider.js`, loop de tool-use compartilhado via `runToolLoop`) e o Lead existente (`outboundMessages/{leadId}` — próprio leadId como ID do doc, nunca um segundo cadastro). Contexto comercial configurável sem tocar em código (`systemConfig/salesContext`, coleção que já existia sem uso real — reaproveitada em vez de criar nova). Geração individual (Gen 1 síncrona) e em lote (mesmo desenho request/execute Gen1+Gen2 da Prospecção IA). 306 testes, 0 falhas — incluindo um bug de corrida real encontrado e corrigido (`claimForGeneration` usava `set()` em vez de `.create()`, permitindo 2 gerações simultâneas pro mesmo lead). | `portal-associativo/docs/roadmap/AGENTE_OUTBOUND_REPORT.md` |
| **Motor de Pricing** — Planos, Módulos, Pricing e Isenções | `systemPlans`/novo `moduleCatalog` viram motor de configuração comercial: 5 planos oficiais (preço comercial sempre independente da soma dos módulos), catálogo centralizado de módulos com dependências técnicas validadas, plano Customizado por organização com cálculo server-authoritative, isenção de cobrança por organização (`organizationSubscriptions.exempt*`, calculada na leitura, nunca altera plano/módulos). Escrita de `systemPlans`/`moduleCatalog` movida pra Cloud-Function-only. 255 verificações, 0 falhas. | `portal-associativo/docs/roadmap/MOTOR_PRICING_PLANOS_MODULOS_REPORT.md` |
| **Pivô Gemini/Claude Code** — Prospecção sem API paga | Prospecção IA trocou de provider (Claude → `geminiProvider.js`, Gemini Developer API/`gemini-flash-latest` + Google Search Grounding, free tier — não Vertex AI) pra eliminar dependência de crédito Anthropic; `claudeProvider.js` preservado como fallback, não apagado. Deploy em produção concluído (18 functions, scheduler `prospectingScheduledRun` ativo). Validado com campanhas reais controladas (6 leads reais criados, evidência auditável, custo real US$0 dentro do free tier). | `portal-associativo/docs/roadmap/PIVO_GEMINI_CLAUDE_CODE_REPORT.md` |
| **Botão "Executar Outbound IA"** — Outbound sem terminal | Elimina a necessidade de abrir Claude Code manualmente toda semana: botão em `admin/leads.html` (Painel Master) → `requestOutboundRemoteRun` (Cloud Function) → dispara `workflow_dispatch` no GitHub Actions (`.github/workflows/outbound-weekly.yml`) → `anthropics/claude-code-action`, autenticado por `CLAUDE_CODE_OAUTH_TOKEN` (GitHub Secret, assinatura Claude Pro — nunca `ANTHROPIC_API_KEY`) → gera as abordagens e grava em `outboundMessages/{leadId}` (mesmo contrato de sempre, reaproveitando `lib/outbound/messages.js`). Firestore acessado pelo runner via Workload Identity Federation (service account dedicada `outbound-remote-runner`, `roles/datastore.user`, sem chave JSON) — usando `@google-cloud/firestore` direto, NÃO `firebase-admin` (achado real: o SDK do firebase-admin não suporta credenciais WIF exportadas pelo `google-github-actions/auth`, confirmado tanto na documentação oficial da action quanto por um teste real que falhou até a correção). Controle de concorrência via lock singleton (`outboundRemoteRuns/_lock`, mesmo idioma de `lib/prospecting/engine.js`). `/outbound-weekly` (execução manual local) preservado como caminho alternativo. Validado com 2 disparos reais em produção (1 lead, depois 4 leads — 5/5 gerados, US$0 de custo). 112 testes automatizados, 0 falhas. | `portal-associativo/docs/roadmap/PIVO_GEMINI_CLAUDE_CODE_REPORT.md` |

**Estado atual consolidado** (não muda por fase — ver `portal-associativo/CLAUDE.md` para o modelo vivo e completo): Painel Master em produção, `platformAdmins` populada, Tenant Resolver por hostname ativo (CCBMG + Sandbox), Feature Flags operacional, configuração de negócio por organização. CCBMG (`org_bonfim`) segue sem Organization Master ativo desde a migração do Platform Owner na Fase 3.2 — decisão operacional, não corrigida automaticamente por design; consequência: `resetUserPassword`/`deleteAssociado` (que exigem Organization Master) seguem inacessíveis até alguém ser designado.

---

## Integração Asaas ✅ (Fase 2 — LIVE)

> A resolução de billing **por organização** (`getBillingProvider`/`getProviderForOrg`, suporte a sandbox vs. produção por tenant) é mecanismo de plataforma — ver Fases 3.4/3.7 na tabela acima. Esta seção documenta a integração **específica do CCBMG** (conta de produção, planos, webhook).

**API:** `https://api.asaas.com/v3`
**Segredos no Secret Manager:**
- `projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest` — chave da API
- `projects/clubecavalobonfim/secrets/asaas-webhook-token/versions/latest` — token de autenticação do webhook (associados)
- `projects/clubecavalobonfim/secrets/asaas-auction-webhook-token/versions/latest` — token de autenticação do webhook do módulo de leilões (`auctionAsaasWebhook`, secret distinto do webhook de associados)
- `projects/clubecavalobonfim/secrets/asaas-sandbox-api-key/versions/latest` e `asaas-sandbox-webhook-token` — conta Asaas Sandbox, usada só pelo tenant Sandbox oficial (Fase 3.7)

### Planos e valores (CCBMG — hoje configurável por organização via `organizations/{orgId}.billing.plans[]`, Fase 4; valores abaixo são os do CCBMG)
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
| `asaasWebhook` | HTTP público | Recebe PAYMENT_RECEIVED/CONFIRMED do Asaas (conta produção) → atualiza fatura + finance/summary |
| `asaasSandboxWebhook` | HTTP público | Idem, para a conta Asaas Sandbox (só o tenant Sandbox oficial) |
| `configureAsaasNotifications` | HTTP Callable | Configura 3 avisos SMS por assinatura (−5d, 0, +5d) |
| `syncAllAssociadosToAsaas` | HTTP Callable | Migração em massa (uso pontual) |
| `createAsaasSubscriptions` | HTTP Callable | Criação em massa de assinaturas (uso pontual) |
| `deleteAssociado` | HTTP Callable (master) | Exclui associado (Firestore + Auth) e cancela cliente/assinatura no Asaas |
| `cancelMySubscription` | HTTP Callable (self-service) | Associado confirma CPF+telefone e cancela a própria assinatura — fala direto com o Asaas (pausa assinatura, cancela cobranças em aberto, desliga notificações) e grava `assinaturaCanceladaPeloAssociado:true`, **sem** tocar em `ativo` (ver Autocancelamento); avisa admins por e-mail |
| `reactivateMySubscription` | HTTP Callable (self-service) | Associado reverte um autocancelamento (reativa assinatura, religa notificações, gera cobrança avulsa) — bloqueado se a conta tiver sido desativada pelo admin (`ativo:false`) |

**Webhook URL (produção):**
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
- Envia email HTML via **Nodemailer + Gmail** para os destinatários de `organizations/{orgId}.notificationEmails` (obrigatório desde o provisionamento — Fase 4; sem `notificationEmails` configurado, a organização simplesmente não recebe, nunca cai num fallback pessoal). Para o CCBMG, os destinatários reais foram preservados na migração da Fase 4.
- Credenciais no Secret Manager: `email-user`, `email-password`

---

## Cloud Functions: Prospecção IA

> Mecanismo de **plataforma** (alimenta o funil comercial `leads`, não um fato do CCBMG) — modelo completo, decisões arquiteturais e testes em `portal-associativo/docs/roadmap/PROSPECCAO_IA_REPORT.md`. Aqui só o necessário pra operar/depurar a partir deste repositório.

- Arquivos: `functions/index.js` (exports) + `functions/lib/prospecting/*.js` (campaigns/dedup/scoring/claudeProvider/engine)
- CRUD de campanhas: `createProspectingCampaign`/`updateProspectingCampaign`/`setProspectingCampaignStatus`/`archiveProspectingCampaign` — Callable, Platform Administrator/Owner
- `requestProspectingRun` — Callable (mesmo papel), só reivindica o lock e cria `prospectingRuns/{runId}` com status `"queued"`; devolve na hora
- `prospectingScheduledRun` — agendada, **segunda-feira 08:00 BRT** (`0 8 * * 1`), solicita execução de toda campanha `status:"active"` com `execution.frequencia:"weekly"`
- `executeProspectingRun` — **Gen 2** (`firebase-functions/v2/firestore`, `onDocumentCreated`, timeout 1800s/512MiB) — único desvio do padrão Gen 1 do resto deste arquivo, disparado pela criação do doc de execução; roda o ciclo de verdade (pesquisa via Claude + `web_search` server-side → dedup → score → criação de leads)
- Secret no Secret Manager: `gemini-api-key` (chave da Gemini Developer API, free tier — provider ativo desde o "Pivô Gemini/Claude Code", ver tabela acima). `anthropic-api-key` (Claude) continua no Secret Manager, mas não é mais usada pela Prospecção — `claudeProvider.js` fica preservado como fallback.
- Notificação por e-mail ao final de cada execução: mesmo transporter/credenciais do relatório diário, destinatários = `platformAdmins` com role `administrator`/`owner` (não `organizations/{orgId}.notificationEmails` — este módulo não tem `orgId`)

---

## Cloud Functions: Agente de Outbound

> Mecanismo de **plataforma**, extensão da Prospecção IA acima — modelo completo, decisões arquiteturais e testes em `portal-associativo/docs/roadmap/AGENTE_OUTBOUND_REPORT.md`. Aqui só o necessário pra operar/depurar a partir deste repositório.

- Arquivos: `functions/index.js` (exports) + `functions/lib/outbound/*.js` (salesContext/messages/engine) + `functions/lib/prospecting/claudeProvider.js` (reaproveitado — `generateOutboundApproach`, mesma factory da Prospecção IA)
- `updateSalesContext` — Callable, Platform Administrator/Owner, grava `systemConfig/salesContext` (contexto comercial: proposta de valor, diferenciais, tom, CTA, etc. — editável sem tocar em código)
- `generateOutboundMessage` — Callable síncrona (Gen 1), gera/regenera a abordagem de UM lead (`outboundMessages/{leadId}` — próprio leadId como ID do doc)
- `requestOutboundBatch` + `executeOutboundBatch` — mesmo desenho request(Gen1 rápido)/execute(**Gen 2**, `onDocumentCreated` em `outboundBatches/{batchId}`, timeout 1800s/512MiB) da Prospecção IA; teto de 50 leads por lote
- `approveOutboundMessage`/`rejectOutboundMessage`/`editOutboundMessage`/`markOutboundMessageSent`/`markOutboundMessageResponded` — Callable, nunca tocam o Claude, nunca disparam envio real (marcação sempre manual)
- Secret: reaproveita `anthropic-api-key` (nenhum secret novo) — caminho preservado como fallback, não removido

### Caminho ativo — Botão "Executar Outbound IA" (sem API paga, sem terminal)

Operação semanal normal (Pivô Gemini/Claude Code): botão em `admin/leads.html`, visível só pra quem já tem acesso à página (Platform Administrator/Owner, `requirePlatformAccess`).

```
admin/leads.html ("Executar Outbound IA")
  → previewOutboundRemoteRun (Cloud Function, só leitura — números pro modal de confirmação)
  → requestOutboundRemoteRun (Cloud Function) — reivindica lock (outboundRemoteRuns/_lock,
    mesmo idioma de RUNNING_STALE_MS de lib/prospecting/engine.js), calcula até 20 leads
    elegíveis (lib/outbound/eligibility.js, critério único reaproveitado pelo script local
    também), cria outboundRemoteRuns/{runId} status "pending"
  → lib/outbound/githubDispatch.js dispara workflow_dispatch em
    .github/workflows/outbound-weekly.yml (token github-actions-dispatch-token, Secret
    Manager — escopo repo+workflow, só usado pra essa chamada)
  → GitHub Actions: google-github-actions/auth (Workload Identity Federation — service
    account dedicada outbound-remote-runner@clubecavalobonfim.iam.gserviceaccount.com,
    roles/datastore.user, SEM chave JSON) + anthropics/claude-code-action (autenticado por
    CLAUDE_CODE_OAUTH_TOKEN, GitHub Secret — assinatura Claude Pro, NUNCA ANTHROPIC_API_KEY)
  → Claude Code roda /outbound-weekly-remote (variante não-interativa — a confirmação já
    aconteceu no modal do Portal): lê outboundRemoteRuns/{runId}.leadIdsPlanned (já travado,
    nunca recalculado), gera cada abordagem com seu próprio raciocínio (sem pesquisa web
    adicional), grava via scripts/outbound-weekly-write.js (reaproveita
    lib/outbound/messages.js — mesmo contrato outboundMessages/{leadId} de sempre)
  → scripts/outbound-remote-run-finish.js marca outboundRemoteRuns/{runId} "completed"/
    "failed" e libera o lock — SEMPRE, mesmo em erro (passo de fallback `if: always()` no
    workflow garante isso mesmo se o Claude Code travar/crashar)
  → admin/leads.html acompanha tudo via onSnapshot em outboundRemoteRuns/{runId} (Solicitado
    → Em execução → Concluído/Falhou), sem bloquear a UI
  → revisão humana/envio manual em admin/outbound-ia.html, idêntico a qualquer outro caminho
```

Achado real importante: os scripts (`scripts/outbound-weekly-list.js`, `outbound-weekly-write.js`, `outbound-remote-run-start.js`, `outbound-remote-run-finish.js`) usam `@google-cloud/firestore` DIRETO, não `firebase-admin` — o SDK do firebase-admin **não suporta** credenciais de Workload Identity Federation exportadas pelo `google-github-actions/auth` (confirmado na documentação oficial da action: *"This option is not supported by Firebase Admin SDK"*; confirmado também na prática, "Invalid contents in the credentials file", num teste real antes da correção). `@google-cloud/firestore` fala com `google-auth-library` diretamente, que suporta WIF nativamente — funciona igual com ADC local (`gcloud auth application-default login`) e com WIF no runner, sem trocar lógica nenhuma.

`/outbound-weekly` (execução manual local, descrita acima) continua existindo como caminho alternativo/debug — nunca removido.

---

## Regras de Desenvolvimento

1. Não quebrar funcionalidades existentes — sempre analisar impacto antes de alterar.
2. Usar JavaScript Vanilla (ES Modules). Sem frameworks adicionais.
3. Usar `async/await` consistentemente.
4. Frontend hospedado no GitHub Pages — sem build step, arquivos servidos diretamente.
5. Validar roles admin/master em todas as operações administrativas.
6. Nunca expor secrets em HTML/JS — usar Secret Manager ou variáveis de ambiente nas Functions.
7. Ao adicionar comportamento novo, avaliar se é fato do CCBMG (fica neste arquivo) ou mecanismo de plataforma (documentar em `portal-associativo/CLAUDE.md`/`docs/roadmap/`, mesmo que o código rode a partir deste repositório).
8. Documentar novas coleções Firestore e integrações neste arquivo.

---

## Roadmap

Estado real em agosto de 2026 — Fase 5 (SaaS Multi-Tenant) já está implementada e em produção desde as Fases 3.2–3.12/4 detalhadas acima; a tabela abaixo reflete isso (a versão anterior deste arquivo ainda listava a Fase 5 como item futuro, o que já estava desatualizado frente ao resto do documento).

| Fase | Descrição | Status |
|------|-----------|--------|
| 1 | Portal completo | ✅ |
| 2 | Integração Asaas (assinaturas, webhook, sync bidirecional) | ✅ |
| 3 | Marketplace | Não iniciado |
| 4 | Aplicativo | Não iniciado |
| 5 | SaaS Multi-Tenant (Painel Master, provisionamento, domínios, Tenant Resolver, White Label, Feature Flags, configuração por organização) | ✅ — ver tabela "Evolução da Plataforma Multi-Tenant" acima |
| 6 | IA e automações | Não iniciado |

---

## Segurança e LGPD

- Dados pessoais armazenados: nome, CPF, telefone, endereço
- Regras de acesso centralizadas no Firebase (não confiar no frontend)
- Webhook Asaas validado por token no Secret Manager + verificação do pagamento na API
- Auditoria de segurança de toda a plataforma (isolamento cross-tenant, escalada de privilégio, billing, backup, alertas): ver "Auditoria Final RC1" na tabela acima — resultado GO WITH CONDITIONS, achados abertos (P2/P3) documentados em `portal-associativo/docs/roadmap/AUDITORIA_FINAL_RC1_REPORT.md`
- A implementar: exportação, exclusão e anonimização de dados (LGPD)

---

## Como Agir como Colaborador

Ao propor mudanças, sempre:
1. Explicar impacto e riscos
2. Listar arquivos afetados
3. Propor versão simples e escalável
4. Priorizar baixo custo e compatibilidade com GitHub Pages + Firebase
5. Antes de documentar algo novo aqui, considerar se é fato do CCBMG ou arquitetura de plataforma (ver seção "Organização" no topo deste arquivo)
