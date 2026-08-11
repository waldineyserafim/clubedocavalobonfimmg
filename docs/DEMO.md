# Ambiente de Demonstração — Guia Rápido

> **Atualizado — Fase 3.10 (2026-08-11).** Igual ao [DEVELOPMENT.md](DEVELOPMENT.md), este arquivo é mantido junto do código (ver aviso de desatualização em [README.md](README.md) sobre o resto de `docs/`).

Referência rápida pra quem vai demonstrar a plataforma pra um cliente — não é documentação de arquitetura (isso está no `CLAUDE.md`, Fase 3.7/3.9/3.10).

## URL

**https://demo.portalassociativo.com.br**

Tenant: **"Clube dos Associados"** (`org_teste_etapa10`) — tenant Sandbox oficial da plataforma. **Nunca contém dado real** — tudo fictício, seguro pra mostrar/mexer à vontade numa demonstração.

⚠️ **Branding visual ainda não reflete o tenant**: o HTML é servido por proxy direto do site do CCBMG (ver CLAUDE.md, Fase 3.9), e as páginas públicas (`login.html` etc.) têm o nome/logo "Clube do Cavalo" hardcoded no HTML estático — só elementos marcados com `[data-tenant-name]`/`[data-tenant-logo]` trocam dinamicamente, e as páginas atuais não têm essas marcações. Ou seja: a tela mostra "Clube do Cavalo - Bonfim MG" no título/logo, mas os **dados** (login, associados, eventos, financeiro) já são 100% do "Clube dos Associados". Avise quem for demonstrar, pra não causar confusão.

## Usuários de teste

**Senha padrão de todas as contas: `SandboxDemo#2026`**

| Papel | Login | Onde logar |
|---|---|---|
| **Master** (Organization Master) | `sandbox_master_01@sandbox.invalid` | `/login_master.html` (e-mail, não CPF) |
| **Admin** (Organization Administrator) | `sandbox_admin_01@sandbox.invalid` | `/login_master.html` (e-mail, não CPF) |
| **Associado** (adimplente, exemplo pronto) | CPF `55781866884` | `/login.html` (CPF, não e-mail) |

A equipe administrativa (Master/Admin/Operador) usa e-mail fictício `@sandbox.invalid` e loga por `login_master.html`. Associados logam por CPF em `login.html` — o CPF acima já tem assinatura paga e ativa no Asaas Sandbox, pronto pra mostrar a área do associado sem nenhum aviso de pendência.

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
