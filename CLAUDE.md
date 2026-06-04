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
  asaasSubscriptionSyncedAt (Timestamp)

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
```

---

## Autenticação e Roles

- CPF é convertido para email: `12345678900` → `12345678900@cpf.local`
- Roles: `master` > `admin` > `associado`
- Role cacheada em `sessionStorage` para evitar reads redundantes ao Firestore
- Proteção de rotas via `requireAuth({ requiredRole })` em `firebase.js`
- Botão "Administração" aparece dinamicamente para admin/master via `setupAdminButton()`
- `mapRoleServer(r)` normaliza roles com espaços/acentos via `.normalize('NFD').trim().toLowerCase().includes()`

### Primeiro Acesso
- Quando admin cria associado: `primeiroAcesso: true` gravado no Firestore
- Em `pg_associado.html`: se `primeiroAcesso === true`, abre modal de troca de senha obrigatória (backdrop static, sem botão fechar)
- Após trocar a senha: `primeiroAcesso: false` gravado no Firestore
- Associados que se auto-cadastraram via `signup.html` não têm esse campo

---

## Integração Asaas ✅ (Fase 2 — LIVE)

**API:** `https://api.asaas.com/v3`
**Segredos no Secret Manager:**
- `projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest` — chave da API
- `projects/clubecavalobonfim/secrets/asaas-webhook-token/versions/latest` — token de autenticação do webhook

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
| `onAssociadoAtualizado` | Firestore onUpdate `users/{uid}` | Sincroniza nome/telefone/CPF para o Asaas quando alterados |
| `onInvoicePaid` | Firestore onUpdate `users/{uid}/financeInvoices/{id}` | Baixa cobrança no Asaas quando admin marca fatura como paga |
| `onInvoiceCreatedPaid` | Firestore onCreate `users/{uid}/financeInvoices/{id}` | Idem para faturas criadas diretamente como pagas |
| `asaasWebhook` | HTTP público | Recebe PAYMENT_RECEIVED/CONFIRMED do Asaas → atualiza fatura + finance/summary |
| `configureAsaasNotifications` | HTTP Callable | Configura 3 avisos SMS por assinatura (−5d, 0, +5d) |
| `syncAllAssociadosToAsaas` | HTTP Callable | Migração em massa (uso pontual) |
| `createAsaasSubscriptions` | HTTP Callable | Criação em massa de assinaturas (uso pontual) |

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
