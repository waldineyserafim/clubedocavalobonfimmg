# Ambiente de Demonstração — Guia Rápido

> **Atualizado — Fase 3.11 (2026-08-11).** Igual ao [DEVELOPMENT.md](DEVELOPMENT.md), este arquivo é mantido junto do código (ver aviso de desatualização em [README.md](README.md) sobre o resto de `docs/`).

Referência rápida pra quem vai demonstrar a plataforma pra um cliente — não é documentação de arquitetura (isso está no `CLAUDE.md`, Fase 3.7/3.9/3.10/3.11).

## URL

**https://demo.portalassociativo.com.br**

Tenant: **"Clube dos Associados"** (`org_teste_etapa10`) — tenant Sandbox oficial da plataforma. **Nunca contém dado real** — tudo fictício, seguro pra mostrar/mexer à vontade numa demonstração.

Branding 100% White Label desde a Fase 3.11 (auditoria completa) — nenhuma página mostra nome/logo/referência ao Clube do Cavalo, tudo vem do branding do próprio tenant (nome, logo, cores, favicon, og:image, meta description).

## Usuários de teste

**Senha padrão de todas as contas: `SandboxDemo#2026`**

| Papel | Login | Onde logar |
|---|---|---|
| **Master** (Organization Master) | CPF `222.333.440-73` | `/login.html` (CPF, mesma tela de qualquer associado) |
| **Admin** (Organization Administrator) | CPF `111.222.330-43` | `/login.html` (CPF, mesma tela de qualquer associado) |
| **Associado** (adimplente, exemplo pronto) | CPF `55781866884` | `/login.html` (CPF) |

Master/Admin logam pela **mesma** tela que qualquer associado (`login.html`, CPF) — depois do login, o botão "Administração" aparece automaticamente (`setupAdminButton()`, `firebase.js`) e leva pra `admin.html`, o painel de gestão de conteúdo da organização (associados, eventos, galeria, diretoria, produtos, serviços, classificados). **Não existe uma tela de login separada pra admin da organização** — `login_master.html`/`admin_master.html` (e a família `admin_master_*.html`) é um mecanismo antigo, anterior à separação do Painel Master pro repositório `portal-associativo` (Fase 3.1/3.2): consulta `organizations` cross-tenant e só aceita `role==="master"` — nunca `"admin"` — então nunca teria servido pra esse caso mesmo antes de virar código morto. Ver `CLAUDE.md`, seção "Fase 3.12" pra detalhe completo.

Existem mais 39 associados/mirins cobrindo outros cenários (inativo, cancelado, inadimplente, recém-cadastrado) — todos com a mesma senha. Peça a lista completa se precisar demonstrar um cenário específico.

## Como restaurar o ambiente após uma demonstração

Qualquer alteração feita durante uma demo (marcar fatura como paga, desativar um associado, criar um classificado novo, etc.) pode ser revertida rodando o Seed Oficial de novo — ele é **idempotente**, sempre converge pro mesmo estado canônico, nunca duplica:

```bash
cd functions
node scripts/seedSandboxTenant.js all
```

Pré-requisitos: estar logado via `gcloud auth login` numa conta com acesso ao projeto `clubecavalobonfim` (o script usa esse login pra falar com Firestore/Auth/Secret Manager/Asaas Sandbox — não precisa de nenhuma outra credencial). Leva alguns minutos (faz chamadas reais à API do Asaas Sandbox pra restaurar os cenários financeiros).

Detalhe do que é restaurado, passo a passo do script, e como rodar só uma parte (ex.: só o financeiro) estão documentados no cabeçalho de `functions/scripts/seedSandboxTenant.js` e em `CLAUDE.md` (Fase 3.7).

## Restaurar só o branding (sem tocar em mais nada)

Se durante a demo você só mexeu em logo/cores (aba "Identidade Visual", pra mostrar personalização de marca) e quer voltar rápido pro visual oficial **sem** rodar o Seed Oficial inteiro (que reprocessa associados/financeiro e chama a API do Asaas Sandbox de verdade, levando minutos), use o botão dedicado no Painel Master:

**Painel Master → Organizações → Clube dos Associados (`org_teste_etapa10`) → Central de Configuração → Identidade Visual → "Restaurar Branding da Demonstração"**

- Restaura só `organizations/org_teste_etapa10.config.{corPrimaria,corSecundaria,logoUrl,faviconUrl}` pros valores oficiais — instantâneo, sem chamar Asaas nem tocar em nenhum outro dado.
- Botão só aparece pra este tenant (o backend, `restoreSandboxBranding` em `functions/index.js`, também recusa a operação pra qualquer outra organização, mesmo que alguém tente forçar via chamada direta).
- Pode ser clicado quantas vezes forem necessárias (idempotente).
- Não substitui o Seed Oficial acima pra restaurar dados funcionais (associados, eventos, financeiro etc.) — só branding.

Detalhe da implementação, campos oficiais e como o mecanismo garante que só o Sandbox pode usá-lo: `functions/lib/sandboxBranding.js`.

## Representante comercial — papel e permissões

Cenário: uma pessoa que **não** é dona da plataforma, mas precisa (a) restaurar o branding do Sandbox antes de cada demo, (b) configurar a org de demo com dados de cada cliente-alvo (nome, logo, cores) antes de apresentar, e (c) navegar o sistema pra apresentar.

### Papel a atribuir: `administrator` (nunca `operator`, nunca `owner`)

| Papel | Serve? |
|---|---|
| `operator` | **Não.** Só leitura nas telas de plataforma. `restoreSandboxBranding` e qualquer "Salvar" da Central de Configuração são bloqueados no servidor (`requirePlatformAdministrator`/Firestore Rules) mesmo que a tela não esconda o botão. |
| `administrator` | **Sim.** Consegue restaurar branding do Sandbox, salvar qualquer aba da Central de Configuração, fazer upload de logo/favicon. Não consegue gerenciar outros `administrator`/`owner` nem ações irreversíveis de plataforma. |
| `owner` | Também serve, mas é mais acesso do que a tarefa exige (gerencia outros donos, ações irreversíveis) — não recomendado só pra isso. |

⚠️ **Risco a conhecer antes de criar a conta**: papel de plataforma não é limitado por organização — `administrator` tem permissão de escrita em **qualquer** `organizations/{orgId}` via Firestore Rules, incluindo o `org_bonfim` (CCBMG, produção real), não só o Sandbox. Não existe hoje um mecanismo de "administrator restrito a uma organização". Orientação prática: só abrir `organization-detail.html?id=org_teste_etapa10` (Clube dos Associados) — nunca a de `org_bonfim`.

### Passo a passo

**1. Você (Platform Owner) cria a conta dela** — só `owner` pode criar um `administrator` (`administrator` só pode criar `operator`, nunca outro `administrator`):
   - Login em `login_master.html` com sua conta owner.
   - Painel Master → **Equipe de Plataforma** (`admin/platform-operators.html`) → "Novo".
   - Nome, e-mail dela, papel = **Platform Administrator** (só aparece liberado no dropdown porque você é owner) → Cadastrar.
   - Isso cria a conta no Firebase Auth e envia um e-mail ("Acesso ao Painel Master — defina sua senha") com um link de definição de senha — nenhuma senha em texto puro é transmitida. Se o e-mail falhar, a tela mostra o link pra você repassar manualmente.

**2. Ela define a senha e loga**
   - Abre o e-mail recebido, define a senha.
   - Login em `login_master.html` (e-mail + senha — **não** é o `login.html` de CPF, esse é só pra associados).

**3. Antes de cada apresentação — restaurar o branding**
   - Painel Master → Organizações → **Clube dos Associados** (`org_teste_etapa10`) → Central de Configuração → aba **Identidade Visual** → botão **"Restaurar Branding da Demonstração"**.
   - Restaura instantaneamente `config.{corPrimaria, corSecundaria, logoUrl, faviconUrl}` pro oficial do Sandbox — apaga qualquer logo/cor deixada de uma demo anterior. Pode clicar quantas vezes quiser (idempotente), não chama Asaas nem mexe em associados/financeiro.
   - Esse botão **só cobre identidade visual** (as 4 chaves acima). Se ela também mudou nome/telefone/e-mail/site/endereço (aba Geral) numa demo anterior, esses campos **não voltam sozinhos** — reverter é digitar de novo os valores oficiais abaixo.

**4. Configurar a org de demo com os dados do cliente-alvo**
   Mesma tela (`organization-detail.html?id=org_teste_etapa10`), preencher conforme a apresentação pedir:
   - **Geral**: nome, nome curto, descrição, telefone, e-mail, site, endereço — personaliza a demo com o "nome" do prospect.
   - **Identidade Visual**: upload de logo/favicon, cor primária/secundária — pra "vestir" a demo com a cor da marca do prospect, se fizer sentido.
   - Localização/Financeiro/Comunicação/Portal: opcionais, conforme o que for mostrar.
   - Cada aba tem seu próprio botão "Salvar" — grava direto em `organizations/org_teste_etapa10` (permitido pro papel `administrator`).

**5. Apresentar**
   - `https://demo.portalassociativo.com.br` — login com um dos usuários de teste da tabela acima (senha padrão `SandboxDemo#2026`).

**6. Depois da apresentação — restaurar tudo**
   - Repetir o passo 3 (botão de branding).
   - Se mexeu em nome/telefone/e-mail/site/endereço no passo 4, digitar de volta manualmente na aba Geral:

     | Campo | Valor oficial do Sandbox |
     |---|---|
     | Nome / Nome curto | `Clube dos Associados` |
     | Telefone | `5538988887777` |
     | E-mail | `contato@clubedosassociados.demo` |
     | Site | `https://demo.portalassociativo.com.br` |
     | Endereço | `Ambiente de demonstração — sem endereço físico` |

   - Alternativa mais completa (restaura também associados/eventos/financeiro, não só esses campos): rodar o Seed Oficial (`node functions/scripts/seedSandboxTenant.js all`, passo já documentado acima) — mas isso é operação técnica via terminal, não é algo que se espera que ela rode sozinha; é seu papel como owner, se precisar de uma reversão mais profunda.
