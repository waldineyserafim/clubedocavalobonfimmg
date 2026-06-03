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
| Pagamentos | Mercado Pago (PIX, atual) → Asaas (planejado) |
| Segredos | Google Secret Manager (credenciais de email na Cloud Function) |

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
- `signup.html` — Cadastro público
- `pg_associado.html` — Dashboard do associado (banners, status, produtos, serviços, classificados)
- `produtos_associado.html` — Produtos exclusivos
- `servicos_associado.html` — Serviços exclusivos
- `pay.html` — Pagamento (planos Mensal R$30 / Trimestral / Semestral / Anual)
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
- `functions/index.js` — Cloud Function: relatório diário de vencimentos por email (08h BRT)

---

## Firestore Schema

```
users/{uid}
  cpf, nome, apelido, telefone, endereco,
  role (master|admin|associado),
  status, ativo, createdAt, updatedAt

users/{uid}/finance/summary
  activeUntil, nextDue, lastPayment, lastAmount, exempt, exemptUntil, balance

users/{uid}/financeInvoices/{invoiceId}
  amount, dueDate, paidAt, status, planType, planStart, planEnd

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

---

## Integração Asaas

Arquivo: `functions/index.js`

| Função | Tipo | Descrição |
|--------|------|-----------|
| `syncAllAssociadosToAsaas` | HTTP Callable | Migração em massa — cria/verifica todos os usuários ativos sem `asaasId` no Asaas. Requer role admin/master. |
| `onNewAssociadoCriado` | Firestore onCreate trigger | Sincroniza automaticamente cada novo usuário criado em `users/{uid}`. |

**Campos enviados ao Asaas:** `name` (nome), `cpfCnpj` (CPF), `mobilePhone` (telefone), `externalReference` (Firebase UID)

**Campos salvos no Firestore após sync:** `asaasId` (string), `asaasSyncedAt` (Timestamp)

**Segredo no Secret Manager:** `projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest`

**UI:** Botão "Sincronizar Asaas" em `admin_associados.html` → modal com progresso e resumo de erros.

---

## Cloud Function: Relatório Diário

- Arquivo: `functions/index.js`
- Disparo: todo dia às **08:00 BRT** (`0 8 * * *`)
- Lógica: lê todos os usuários ativos, calcula status de vencimento a partir de `financeInvoices`, agrupa em 4 categorias:
  - Vence hoje
  - A vencer em 5 dias
  - Vencido entre 5 e 10 dias
  - Vencido há mais de 10 dias
- Envia email HTML via **Nodemailer + Gmail** para `waldiney.serafim@gmail.com` e `mpmarquesnutri@gmail.com`
- Credenciais armazenadas no **Secret Manager**: `email-user`, `email-password`

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
| 1 | Portal completo ✅ (em andamento) |
| 2 | Integração Asaas (cadastro automático, cobrança recorrente, webhooks) |
| 3 | Marketplace |
| 4 | Aplicativo |
| 5 | SaaS Multi-Tenant |
| 6 | IA e automações |

---

## Segurança e LGPD

- Dados pessoais armazenados: nome, CPF, telefone, endereço
- Regras de acesso centralizadas no Firebase (não confiar no frontend)
- A implementar: exportação, exclusão e anonimização de dados (LGPD)

---

## Como Agir como Colaborador

Ao propor mudanças, sempre:
1. Explicar impacto e riscos
2. Listar arquivos afetados
3. Propor versão simples e escalável
4. Priorizar baixo custo e compatibilidade com GitHub Pages + Firebase
