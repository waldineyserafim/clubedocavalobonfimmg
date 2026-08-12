# CCBMG — Documentação Técnica Completa

> **⚠️ Desatualizado a partir da Fase 2B (pós 2026-07-21).** Esta pasta inteira foi gerada por uma leitura integral do código numa data específica (ver abaixo) e nunca foi reconciliada desde então — não cobre o Painel Master reconstruído em `portal-associativo/admin/`, administração de plataforma, provisionamento automático de organizações, configuração por organização, identidade do tenant/domínios, nem o hardening da Fase 3.6. **`CLAUDE.md`, na raiz do repositório, é a fonte de verdade atual** — leia-o primeiro. Use esta pasta só como referência histórica do estado do sistema em 2026-07-21.

**Clube do Cavalo de Bonfim MG** — portal institucional, área de associados, marketplace de classificados, leilões online e um painel "master" de administração SaaS multi-tenant embrionário, construído sobre GitHub Pages + Firebase + Asaas.

Esta documentação foi gerada a partir de leitura integral do código-fonte (HTML, `firebase.js`, `functions/index.js`, Firestore/Storage Rules, índices, testes e2e) em 2026-07-21. Onde a documentação do projeto vigente à época (`CLAUDE.md`, `MODULOS.md`) divergia do que o código realmente fazia, isso foi sinalizado explicitamente ao longo destes documentos (ver especialmente [ARCHITECTURE.md](ARCHITECTURE.md) e [TECH_DEBT.md](TECH_DEBT.md)) — mas isso descreve o estado de 2026-07-21, não o atual.

## Como navegar esta documentação

| Documento | Conteúdo |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | **✅ Atualizado (Fase 3.8)** — ambiente local, emuladores, testes, lint, troubleshooting |
| [DEMO.md](DEMO.md) | **✅ Atualizado (Fase 3.10)** — URL de demonstração, usuários de teste, como restaurar o Sandbox |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Visão geral, arquitetura, princípios, limitações, roadmap real vs. documentado |
| [INFRASTRUCTURE.md](INFRASTRUCTURE.md) | Hospedagem, Firebase, domínio, ambientes, deploy |
| [DATABASE.md](DATABASE.md) | Todas as coleções Firestore, campos, tipos, relacionamentos |
| [AUTHENTICATION.md](AUTHENTICATION.md) | Firebase Auth, CPF→email, roles, sessões, redefinição de senha via SMS |
| [FIRESTORE.md](FIRESTORE.md) | Análise linha a linha das Security Rules |
| [STORAGE.md](STORAGE.md) | Regras de Storage, paths de upload, convenções |
| [SECURITY.md](SECURITY.md) | Auditoria de segurança completa (achados, risco, prioridade) |
| [ASAAS.md](ASAAS.md) | Integração de pagamentos — clientes, assinaturas, cobranças, webhooks |
| [FEATURES.md](FEATURES.md) | Todas as funcionalidades por módulo (público, associado, leilões) |
| [ADMIN.md](ADMIN.md) | Toda a área administrativa e o painel master |
| [FLOWS.md](FLOWS.md) | Fluxos de negócio ponta a ponta com diagramas Mermaid |
| [DEPLOY.md](DEPLOY.md) | Como publicar em produção, rollback |
| [PERFORMANCE.md](PERFORMANCE.md) | Consultas, índices, custos, cache |
| [MAINTENANCE.md](MAINTENANCE.md) | Como estender o sistema (nova página, módulo, coleção, integração) |
| [TECH_DEBT.md](TECH_DEBT.md) | Dívida técnica e divergências código×documentação |
| [GLOSSARY.md](GLOSSARY.md) | Termos técnicos e de negócio **do tenant** — termos de plataforma em `portal-associativo/docs/glossary/README.md` |
| [diagrams/](diagrams/) | Diagramas Mermaid isolados, reutilizáveis |
| [archive/](archive/) | Documentos históricos, incluindo `SAAS_MULTITENANT.md` (gap analysis original — a maior parte já resolvida, ver banner no topo de cada arquivo arquivado) |

## Visão geral do projeto

### Objetivo do sistema

Digitalizar a gestão de um clube equestre físico (Clube do Cavalo de Bonfim, MG): cadastro e cobrança recorrente de associados, comunicação institucional (eventos, diretoria, parceiros, galeria), um marketplace de classificados entre associados, e — na camada mais recente e sofisticada do sistema — uma plataforma de **leilões online de cavalos, genética e equipamentos** com lances em tempo real e liquidação financeira via Asaas.

O sistema é desenvolvido e mantido pela **Serafim Technologies** (ver `login_master.html:6`, `MODULOS.md:4`), que também está posicionando o produto como uma base **SaaS multi-tenant** para outros clubes ("Sistema de Gestão de Clubes e Associações" — `MODULOS.md:4`), embora essa camada multi-tenant ainda esteja parcialmente implementada (ver [ARCHITECTURE.md](ARCHITECTURE.md)).

### Problema que resolve

- Substitui controle manual/planilha de mensalidades por cobrança recorrente automatizada (Asaas) com reconciliação diária e relatório por e-mail à diretoria.
- Dá autoatendimento ao associado: login, pagamento, cancelamento/reativação de assinatura, redefinição de senha via SMS — sem depender da secretaria para tarefas rotineiras.
- Centraliza comunicação institucional (eventos, diretoria, galeria, parceiros) num CMS simples editável pelo admin, sem precisar mexer em HTML.
- Cria um canal de renda adicional/engajamento via classificados pagos e leilões com comissão (10% sobre o valor arrematado).
- Permite inscrição e check-in de eventos com QR Code, sem papel.

### Público-alvo

- **Associados** do clube (pessoa física, cadastro por CPF) — usuários finais da área logada.
- **Visitantes** do site público (não associados) — leem conteúdo institucional, veem classificados/leilões, podem se inscrever em eventos.
- **Diretoria/Secretaria** (roles `admin`/`master`) — operam o CRM/financeiro/CMS pelo painel administrativo.
- **Serafim Technologies** (role `master`, login dedicado em `login_master.html`) — mantém a plataforma, opera o painel SaaS (`admin_master*.html`), habilitado a gerenciar múltiplas organizações (tenants) no futuro.
- **Participantes de leilão** (`role: participanteLeilao`) — público externo, não necessariamente associado, cadastrado apenas para dar lances em leilões.

### Principais funcionalidades

1. Site institucional público (home, sobre, diretoria, parceiros, eventos, galeria).
2. Cadastro e login de associados por CPF, com senha definida no autocadastro ou provisória no cadastro pelo admin (fluxo de primeiro acesso obrigatório).
3. Redefinição de senha self-service via SMS (Firebase Phone Auth) — feature mais recente do repositório (commit `b30a76f8`).
4. Cobrança recorrente de anuidade via Asaas (PIX/boleto/cartão), com 3 planos (mensal/trimestral/semestral) e categoria especial "Mirim" (associado sem login, cobrado no CPF do responsável, 50% do valor).
5. Autocancelamento e reativação de assinatura pelo próprio associado, sem perder acesso até o fim da vigência já paga.
6. Vitrines exclusivas de Produtos e Serviços para associados.
7. Classificados: públicos para leitura, publicáveis apenas por associados logados, moderados pelo admin.
8. Leilões online: cadastro de lote pelo associado, aprovação pelo admin, lances em tempo real com transação atômica e anti-sniper, encerramento automático, geração de venda/cobrança e repasse ao vendedor descontada comissão.
9. Inscrição pública em eventos com controle de vagas, prazo e exigência de "sócio em dia"; comprovante com QR Code; check-in por staff autenticado.
10. Painel administrativo completo (CRUD de todo o conteúdo do site, gestão financeira dos associados, auditoria de sincronização Asaas, exclusão de associado).
11. Painel "master" (Serafim Technologies): cadastro de organizações/tenants, módulos habilitáveis por organização, configurações globais, faturamento SaaS manual — parcialmente implementado (ver limitações abaixo).
12. Relatório diário automático por e-mail à diretoria sobre vencimentos/atrasos.

### Visão geral da arquitetura

Arquitetura **serverless, sem build step**: HTML estático servido diretamente pelo GitHub Pages, JavaScript vanilla em módulos ES importados via `<script type="module">`, comunicação direta do browser com Firebase (Auth/Firestore/Storage) via SDK modular carregado por CDN (`gstatic.com/firebasejs/11.0.1`), e um backend de Cloud Functions (Node 22) que concentra toda a lógica sensível (chave de API do Asaas, exclusão de conta, troca de senha, transações de lance). Ver detalhamento em [ARCHITECTURE.md](ARCHITECTURE.md).

### Tecnologias

Ver tabela completa em [ARCHITECTURE.md](ARCHITECTURE.md)/[INFRASTRUCTURE.md](INFRASTRUCTURE.md). Resumo: HTML5 + Bootstrap 5.3.3 + Bootstrap Icons + JavaScript ES Modules; Firebase (Auth, Firestore, Storage, Cloud Functions, Hosting-config presente mas hospedagem real é GitHub Pages); Asaas (gateway de pagamento); Nodemailer/Gmail (e-mail); Google Secret Manager; QRCode.js e jsPDF/autoTable (bibliotecas client-side); Playwright (testes e2e).

### Princípios arquiteturais observados no código (em 2026-07-21 — ver ressalva no topo desta página)

- Sem framework de frontend, sem bundler/build step — compatibilidade total com GitHub Pages estático.
- Toda a lógica de negócio sensível (dinheiro, exclusão de conta, troca de senha, lances) vive em Cloud Functions, nunca só no cliente.
- Padrão consistente de "dado estático de fallback + sobrescrita dinâmica via CMS" nas páginas institucionais.
- Idempotência é tratada de forma explícita e repetida no backend financeiro (`asaasPaymentId` como chave de deduplicação).
- Separação deliberada entre "desativação administrativa" (`ativo:false`, bloqueia login imediatamente) e "autocancelamento" (`assinaturaCanceladaPeloAssociado:true`, mantém acesso até o fim da vigência paga) — documentada em comentários no próprio código.
- Multi-tenant "opt-in": todas as queries do site já filtram por `orgId`, preparando terreno para múltiplos clubes, mas `currentOrgId` é uma constante fixa (`"org_bonfim"`) em `firebase.js:56` — não há resolução dinâmica por domínio ainda. **Isso mudou**: desde a Fase 3.9/3.10 (ver `CLAUDE.md`), `currentOrgId` é resolvido em runtime pelo Tenant Resolver a partir do hostname — não é mais uma constante fixa.

### Limitações identificadas em 2026-07-21 (a maioria já resolvida — ver `CLAUDE.md` para o estado atual)

- **Multi-tenant incompleto**: painel master permite cadastrar organizações, mas nenhuma página do site deriva o tenant do domínio/subdomínio — está hardcoded. Duas Cloud Functions chamadas pela UI (`seedMultiTenantData`, `migrateToMultiTenant`) **não existem** em `functions/index.js` (falharão em produção). Ver [TECH_DEBT.md](TECH_DEBT.md). **Resolvido**: resolução por domínio existe desde a Fase 3.9/3.10; os dois botões citados foram removidos como código morto na Fase 3.6.
- **`systemPlans`** existe só nas regras/testes, sem UI de gestão real — planos são hardcoded em 3 arquivos admin diferentes.
- **`gerarCobrancaLeilao`** (gerar cobrança do lote arrematado) não tem nenhum botão de UI que a acione.
- Nenhuma página usa o guard oficial `requireAuth()` de forma 100% consistente — algumas reimplementam a checagem inline (ex. `login.html`, `pay.html`).
- Sem paginação real nas listagens grandes (ex. `admin_associados.html` carrega todos os usuários da organização).
- Sem testes unitários de backend — a suíte Playwright cobre majoritariamente inspeção estática de código-fonte, não execução real das Cloud Functions.

### Roadmap identificado

O `CLAUDE.md` documenta um roadmap de 6 fases (Portal ✅ → Asaas ✅ → Marketplace → Aplicativo → SaaS Multi-Tenant → IA). O código mostra que a fase "Marketplace" já avançou (classificados + leilões existem e funcionam), e fragmentos da fase "SaaS Multi-Tenant" já foram iniciados (painel master, `organizations`, `orgId` em todas as coleções) antes mesmo de o roadmap documentado declarar isso como concluído — ou seja, o desenvolvimento avançou mais rápido que a documentação oficial do projeto.

## Cobertura desta documentação

Ver seção final de cada análise e o resumo consolidado no fim de [TECH_DEBT.md](TECH_DEBT.md), que também traz a tabela de "Cobertura da Documentação" solicitada (arquivos analisados, funcionalidades, integrações, coleções, Cloud Functions, regras).
