# Clube do Cavalo de Bonfim MG (CCBMG)

Portal do associado do **Clube do Cavalo de Bonfim MG** — site público, área do associado (cadastro, mensalidade, produtos/serviços exclusivos, classificados) e painel administrativo do clube.

🔗 Produção: https://clubedocavalobonfim.com.br

## Relação com o Portal Associativo

Este repositório é o **tenant CCBMG** rodando sobre a plataforma SaaS multi-tenant **Portal Associativo** (repositório irmão: [`portal-associativo`](https://github.com/waldineyserafim/portal-associativo)). Na prática, este repositório contém duas coisas:

1. O frontend específico do clube (páginas públicas, área do associado, painel admin do CCBMG).
2. O **backend compartilhado da plataforma inteira** (`functions/`, `firestore.rules`, `storage.rules`) — existe um único projeto Firebase (`clubecavalobonfim`), usado tanto pelo CCBMG quanto pelo tenant Sandbox oficial de demonstração.

O Painel Master (administração cross-tenant da plataforma, usado pela equipe da Serafim Technologies) e o núcleo de frontend compartilhado (`shared/`, consumido por este repositório via ES Modules cross-origin) vivem no repositório `portal-associativo`.

Para o modelo de arquitetura da plataforma (multi-tenant, papéis, Tenant Resolver, White Label, Feature Flags), ver [`portal-associativo/CLAUDE.md`](../portal-associativo/CLAUDE.md). Para os fatos e a implementação deste tenant/backend, ver [`CLAUDE.md`](./CLAUDE.md) neste repositório — é a fonte de verdade viva do projeto, mais atual que a pasta `docs/`.

## Stack

HTML5 + CSS3 + Bootstrap 5.3 + JavaScript Vanilla (ES Modules), sem build step — hospedado no GitHub Pages. Backend em Cloud Functions (Node.js 22) sobre Firebase (Auth, Firestore, Storage). Pagamentos via Asaas (assinaturas recorrentes, PIX/boleto/cartão, webhooks).

## Como rodar localmente

```bash
npm install          # instala a raiz + functions/ junto (postinstall)
npm run dev           # sobe os emuladores do Firebase (Firestore, Auth, Functions, Storage)
npm test               # roda a suíte completa contra o emulador (unidade + Firestore Rules + Storage Rules)
npm run lint            # ESLint em functions/**, firebase.js, tenant.config.js
npm run build             # node --check em todo .js do repositório (não há bundler)
```

Pré-requisitos, incluindo como instalar o `java` exigido pelos emuladores do Firebase: ver [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

O frontend é servido estático (sem Hosting emulator) — abra os arquivos `.html` diretamente ou sirva a pasta com qualquer servidor estático simples.

## Documentação

- [`CLAUDE.md`](./CLAUDE.md) — arquitetura, schema do Firestore, integração Asaas, regras de desenvolvimento. Fonte de verdade atual.
- [`MODULOS.md`](./MODULOS.md) — especificação dos módulos habilitáveis por organização.
- [`docs/`](./docs/) — documentação técnica detalhada por assunto (ver [`docs/README.md`](./docs/README.md) para o índice e o que está atualizado vs. histórico).
- [`docs/DEMO.md`](./docs/DEMO.md) — como acessar/restaurar o ambiente de demonstração (tenant Sandbox oficial da plataforma).

## Ambiente de demonstração

Existe um tenant Sandbox oficial da plataforma ("Clube dos Associados"), servido em `demo.portalassociativo.com.br`, com dados fictícios — nunca dados reais do CCBMG. Ver [`docs/DEMO.md`](./docs/DEMO.md).
