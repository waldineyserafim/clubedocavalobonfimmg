# Área Administrativa e Painel Master

> **Nota de escopo (agosto de 2026)**: levantamento de 2026-07-21 — cobre só `admin.html`/`admin_*.html` deste repositório (painel de **organização**). Não cobre `admin_configuracoes.html` (autoatendimento do Organization Master, Fase 4) nem o Painel Master real de **plataforma** (`portal-associativo/admin/*.html`, cross-tenant, Fase 3.1+). Onde este documento menciona um "painel master" embutido neste repositório (`admin_master*.html`/`login_master.html`), isso hoje é mecanismo legado/código morto — ver `CLAUDE.md`, Fase 3.12.

## Convenções transversais de todas as telas admin

- Guarda de rota: `requireAuth({requiredRole:["Admin","Master","admin","master","Admin View","adminView"]})`, normalizado por `mapRole()`.
- `adminView` recebe as mesmas telas que `admin`/`master`; a diferença é só um **banner** de "somente leitura" (`firebase.js:239-247`) e algumas regras CSS (`body.admin-view-mode`, `design-system.css:576-609`) que ocultam botões de ação por id/classe/atributo — **não há bloqueio funcional real de escrita** em nenhuma tela lida, exceto o botão de excluir associado (restrito a `master` tanto no front quanto no backend).
- `applyModuleVisibility()`/`checkModuleEnabled()` — a maioria das telas de catálogo (produtos/serviços/classificados/associados) bloqueia a tela inteira se o módulo estiver desativado; as telas de CMS puro (banners/diretoria/eventos/parceiros/galeria/sobre) **não** fazem essa checagem.
- `logAction()` grava em `systemLogs` para praticamente toda ação de CMS/leilão/organização — **exceção**: `admin_associados.html` só loga a criação de associado; as demais ações da tela mais crítica do sistema (edição, financeiro, sync Asaas, exclusão) **não geram entrada em `systemLogs`** (ver [TECH_DEBT.md](TECH_DEBT.md)).

## Hub (`admin.html`)

Grade de navegação para os demais módulos + bloco de "Integrações": 4 Cloud Functions de auditoria/sincronização em massa, sem payload, com confirmação antes de rodar:
- `auditCpfs` — CPFs ausentes/inválidos/tamanho errado entre associados ativos.
- `auditAsaasSync` — associados sem `asaasId`/sem `asaasSubscriptionId`.
- `syncAllAssociadosToAsaas` — cria clientes Asaas faltantes.
- `createAsaasSubscriptions` — cria assinaturas faltantes.

## CRUD de catálogo — Produtos e Serviços (`admin_produtos.html`, `admin_servicos.html`)

CRUD completo sem exclusão física (apenas `active` toggle). Campos comuns: título, benefício, descrição, WhatsApp, destaque (`featured`), até 3 imagens comprimidas (~300KB/1600px, path `uploads/products|services/...`). Produtos tem campo `price`; Serviços permite exclusão individual de imagem já publicada (com tentativa de `deleteObject` no Storage). Nenhuma Cloud Function envolvida — 100% Firestore direto (`addMemberProduct`/`updateMemberProduct`/`addMemberService`/`updateMemberService` de `firebase.js`, mais `updateDoc` direto para campos não cobertos pelos helpers).

## Moderação de Classificados (`admin_classificados.html`)

CRUD + moderação: aprovar (`approved:true, reviewed:true, active:true, paymentStatus:"pago"`) / reprovar (`approved:false, reviewed:true`) — cada ação chama `logAction`. Campo "Destaque" só habilitado para admin/master (bloqueado via JS, não via regra). Upload mais permissivo (~600KB/1600px, até 10 imagens, path `uploads/classifieds/...`). Sem exclusão física.

## CMS de Conteúdo

Todas seguem o mesmo esqueleto de CRUD + soft delete (`deleted:true`) + `logAction`:

| Tela | Coleção | Campos específicos | Path de Storage |
|---|---|---|---|
| `admin_banners.html` | `cms_banners` | título, subtítulo, link, ordem, ativo | `tenants/{orgId}/cms/banners/` |
| `admin_diretoria.html` | `cms_board` | nome, cargo, ordem, categoria, contato, foto (avatar 150KB/600px) | `tenants/{orgId}/cms/diretoria/` |
| `admin_eventos.html` | `cms_events` | título, data/hora, local, valor, imagem, + bloco de **inscrições internas** (`permiteInscricao`, `dataEncerramento`, `maxInscritos`, `somenteSocioEmDia`) | `tenants/{orgId}/cms/eventos/` |
| `admin_galeria.html` | `cms_gallery` (+ subcoleção `fotos`) | título do álbum, `coverUrl` (auto = 1ª foto), upload múltiplo drag-and-drop | `tenants/{orgId}/cms/galeria/{albumId}/` |
| `admin_parceiros.html` | `cms_partners` | nome, categoria, ordem, site, WhatsApp, destaque | `tenants/{orgId}/cms/parceiros/` |
| `admin_sobre.html` | `cms_about/{orgId}` (doc único) | missão, atividades, benefícios, planos (texto), documentos, dados legais (CNPJ etc.) — **não é lista/CRUD**, é um formulário único | — (sem upload) |
| `admin_conteudo.html` | (leitura de todas acima) | dashboard de contadores (total/ativos/última atualização por módulo) — **somente leitura**, sem escrita | — |

**Inconsistência de convenção de Storage** identificada: telas de CMS usam `tenants/{orgId}/cms/...`; Produtos/Serviços/Classificados usam `uploads/...` (fora do prefixo de tenant) — ver [TECH_DEBT.md](TECH_DEBT.md).

## Gestão de Inscrições em Eventos (`admin_inscricoes.html`)

Tela operacional (não CRUD de conteúdo): seleciona um evento com `permiteInscricao`, lista inscritos (`eventRegistrations`), métricas por status, ações "confirmar presença" (check-in manual) e "cancelar inscrição" (ambas `updateDoc` direto + `logAction`), export em PDF (jsPDF+autoTable), link para o modo de check-in por QR (`event_checkin.html`) e para o comprovante individual.

## Central de Gestão de Associados (`admin_associados.html`) — 2803 linhas, tela mais complexa do sistema

### Filosofia: "gestão por exceção"
A tela não lista soltos — agrupa em 3 tiers: **Pendentes** (🔴, aberto por padrão — qualquer situação que exija contato: inconsistência Firestore×Asaas, fatura vencida/atrasada, sem cobrança, sem plano), **Ativos** (🟢, recolhido — em dia, incluindo quem vence em ≤7 dias e isentos), **Inativos** (⚫, recolhido — `ativo:false`). Não é um dashboard financeiro somando valores em R$ — propositalmente.

### Indicadores/filtros
Total, Pendentes, Vence em 7 dias, Sem plano, Sem sinc. Asaas, Inativos (cada um clicável como filtro). Filtros adicionais: financeiro, assinatura, vencimento, plano; ordenação por prioridade/nome/vencimento/atraso/valor.

### Cadastro (modal "Cadastrar associado")
Dois tipos:
- **Normal**: CPF + senha inicial → cria conta Auth numa **app Firebase secundária** (evita deslogar o operador) → `setDoc(users/{uid})` com `role:"Associado", ativo:true, primeiroAcesso:true`.
- **Mirim**: sem conta Auth (não acessa o portal) — doc `users` com id automático, dados do responsável financeiro (`responsavelNome/Cpf/Telefone`), `categoriaAssociado:"mirim"`, cobrado a 50% no CPF do responsável.
- Ambos: cria `finance/summary` inicial; opcionalmente lança fatura inicial (`createInitialFinanceIfNeeded`).
- A criação do cliente/assinatura no **Asaas não é feita pelo front** — é automática via trigger `onNewAssociadoCriado` (Firestore `onCreate`).

### Edição (aba "Dados Gerais")
Nome, apelido, CPF (ou dados do responsável se mirim), telefone, e-mail, endereço, role, ativo, nota de desativação, isenção. Ao desativar (`ativo:false`), grava `desativadoEm`/`desativadoPor` no mesmo `updateDoc`. **A desativação em si não chama nenhuma Cloud Function de cancelamento Asaas diretamente** — quem reage a essa mudança é o trigger `onAssociadoAtualizado`, que detecta `ativo` mudando e pausa a assinatura/cancela cobranças automaticamente.

### Financeiro (aba "Financeiro")
Últimas 3 faturas + ações: registrar pagamento (`openPaymentModal`), enviar link via WhatsApp, ver todas as faturas. Modal de pagamento cobre criação/edição de `financeInvoices` com recálculo de `finance/summary`. Exclusão de fatura é sempre soft (`status:"cancelado"`). Isenção via `openExemptModal` (grava `exempt`/`exemptUntil` em `finance/summary`). Exportação em massa CSV/PDF sobre os associados selecionados.

### Ações via Cloud Function ("Central Financeira Asaas")
| Ação | Function | Payload |
|---|---|---|
| Gerar cobrança | `asaasCreatePayment` | `{uid, value, description}` |
| Cancelar cobrança | `asaasCancelPayment` | `{uid, asaasPaymentId}` |
| Consultar no Asaas | `asaasGetPaymentStatus` | `{asaasPaymentId}` |
| Atualizar dados (sync) | `asaasSyncAssociado` | `{uid}` |
| Redefinir senha (só master) | `resetUserPassword` | `{targetUid, newPassword}` |
| Excluir associado (só master) | `deleteAssociado` | `{uid}` |

Exclusão tem dupla confirmação: `confirm()` + `prompt()` exigindo digitar o nome exato do associado.

### Abas de leitura
"Cobrança" (somente leitura, atalhos de comunicação) e "Auditoria" (status de sincronização, resultado da última sync, último webhook recebido — consumindo `users/{uid}.asaasSync`).

### Categoria Mirim
Sem conta Auth, sem CPF próprio obrigatório, cobrado no CPF do responsável, 50% do valor do plano, badge visual roxo, sem botão de redefinir senha (não tem login).

## Painel Master (SaaS multi-tenant)

### `login_master.html`
Login isolado por e-mail real, restrito a `role==="master"` (checagem client-side comparando string exata, não `mapRole()`).

### `admin_master.html` (hub)
KPIs: total/ativas de `organizations`; contagem de `users` com `role!="master"` (**sem filtro de `orgId`** — soma de todos os tenants); contagem de `auctionLots` com `status=="publicado"` (idem, sem filtro de org); tabela de organizações; últimos 20 `systemLogs`.

### `admin_master_associacoes.html` — CRUD de organizações (tenants)
Campos: identificação (nome, slug, CNPJ, domínio), contato, endereço, plano (`starter|professional|enterprise|custom`), módulos habilitados (mapa de booleans), observações. Plano↔módulos: `PLAN_MODULES` hardcoded (duplicado em 3 arquivos — ver [TECH_DEBT.md](TECH_DEBT.md)); ao alterar módulos manualmente, o plano pode virar "custom". Salvar = `setDoc(organizations/{orgId}, ..., {merge:true})`; "Suspender" = `updateDoc({ativo:false})`.

### `admin_master_configuracoes.html`
Configurações globais (`systemConfig/global`): nome da plataforma, URL base, e-mails de notificação; campos de projeto Firebase/região/webhooks são **somente leitura** (informativos). Botões "Executar Seed de Dados" (`seedMultiTenantData`) e "Executar Migração orgId" (`migrateToMultiTenant`) chamam **Cloud Functions que não existem no backend** (`functions/index.js` não as exporta) — vão falhar com `functions/not-found` se clicados hoje. "Limpar Cache de Módulos" é só client-side (`sessionStorage`).

### `admin_master_faturamento.html`
Faturamento SaaS **manual**, sem gateway de pagamento: CRUD de `organizationSubscriptions` (orgId como texto livre, sem validar contra `organizations` reais), cálculo de MRR/ARR no cliente a partir de `valorMensal` das assinaturas `ativa`.

### Administração de Leilões (`admin_leiloes.html`)
4 abas:
1. **Aprovação** — lotes `em_analise`; aprovar (define `startTime`/`endTime`, `status:"publicado"`) ou rejeitar (motivo obrigatório, `status:"rejeitado"`).
2. **Todos os lotes** — busca/filtro; cancelar lote publicado (motivo via `prompt`); carregar histórico de lances sob demanda.
3. **Vendas/Repasses** — lista `auctionSales`; "Liberar repasse" (só se `status==="pago"`) chama Cloud Function `liberarRepasse({saleId})`.
4. **Participantes** — lista `role=="participanteLeilao"`; bloquear/desbloquear manualmente (`inadimplenteLeilao`), convivendo com o bloqueio automático diário (`verificarInadimplentesDiarios`).

## Divergências e achados específicos da área admin (ver também [TECH_DEBT.md](TECH_DEBT.md))

1. `seedMultiTenantData`/`migrateToMultiTenant` chamadas pela UI mas ausentes no backend.
2. `systemPlans` sem UI de gestão real — planos hardcoded e duplicados em `admin_master.html`, `admin_master_associacoes.html`, `admin_master_faturamento.html`.
3. `admin_master_faturamento.html`: `orgId` da assinatura SaaS é texto livre, sem `<select>` vinculado a `organizations` reais.
4. `admin_master.html`: contagens de KPI (`users`, `auctionLots`) não filtram por `orgId` — em um cenário multi-tenant real, somariam dados de todos os tenants sob o rótulo enganoso de "Associados Totais"/"Lotes Publicados".
5. `admin_associados.html` não chama nenhuma função de cancelamento Asaas ao apenas desativar (`ativo:false`) — depende inteiramente do trigger `onAssociadoAtualizado` reagir corretamente; funcionalmente correto, mas não óbvio para quem lê só o front.
