# Infraestrutura

## Hospedagem

- **Frontend**: GitHub Pages, servindo os arquivos estáticos diretamente da raiz do repositório `waldineyserafim/clubedocavalobonfimmg`. Existe um arquivo `CNAME` na raiz (domínio customizado) e um commit dedicado (`7f4dc472 "Add .nojekyll to disable Jekyll processing"`) que desativa o processamento Jekyll padrão do GitHub Pages — necessário porque nomes de arquivo/pastas começados com `_` (nenhum caso aqui) ou certas convenções seriam ignorados pelo Jekyll por padrão; o `.nojekyll` garante que todos os arquivos (inclusive os que começam com `_`/`.`) sejam servidos como estão.
- **Backend**: Firebase Cloud Functions, projeto `clubecavalobonfim`, `runtime: nodejs22` (`firebase.json:11`).
- **Banco**: Cloud Firestore (mesmo projeto Firebase).
- **Arquivos**: Firebase Storage, bucket `clubecavalobonfim.firebasestorage.app` (`firebase.js:43` — comentário no código alerta para possível necessidade de trocar para `clubecavalobonfim.appspot.com` em caso de erro 403).
- **Config local de emuladores** (`firebase.json:13-18`): Auth (9099), Firestore (8080), Functions (5001), UI (4000) — usados apenas em desenvolvimento local via `firebase emulators:start`.

## Domínio e HTTPS

- Domínio customizado via `CNAME` (GitHub Pages), com HTTPS gerenciado automaticamente pelo GitHub Pages (Let's Encrypt).
- Webhook público do Asaas aponta para o domínio de Cloud Functions gerenciado pelo Google (`https://us-central1-clubecavalobonfim.cloudfunctions.net/...`), que também é HTTPS por padrão.

## Ambientes

Não há separação formal de ambientes (dev/staging/prod) no Firebase — um único projeto (`clubecavalobonfim`) serve produção. O "ambiente de desenvolvimento" observado é:
- Local: `npm run serve` (`package.json:7`, script `npx serve . -l 3333 --no-clipboard`) — serve os arquivos estáticos localmente na porta 3333, usado pelos testes Playwright (`playwright.config.js`).
- Emuladores Firebase configurados em `firebase.json`, mas não há evidência de uso rotineiro (scripts `functions/package.json` apontam para `firebase emulators:start --only functions` e `firebase functions:shell`).
- Não há pipeline de CI/CD configurado no repositório (nenhum arquivo `.github/workflows` foi encontrado) — deploys são manuais.

## Deploy

Ver detalhamento em [DEPLOY.md](DEPLOY.md). Resumo:
- **Frontend**: `git push` para a branch servida pelo GitHub Pages — não há build, o HTML/CSS/JS já está pronto para produção no próprio repositório.
- **Cloud Functions/Rules**: `firebase deploy` (ou `firebase deploy --only functions`/`--only firestore:rules`/`--only storage`), executado manualmente pelo desenvolvedor.

## Versionamento

- Git + GitHub (`waldineyserafim/clubedocavalobonfimmg`), branch principal `main`.
- Sem tags/releases formais observadas — histórico de commits é a fonte de verdade sobre a evolução (mensagens de commit em português, descritivas, ex.: `b30a76f8 Adiciona reset de senha self-service via SMS`).
- `.gitignore` (raiz) ignora `node_modules/`, todo `*.json` exceto `firebase.json`/`package.json`/`firestore.indexes.json`, `.env`, `.DS_Store`, `.firebase/`, `firebase-debug.log*`, `*.log`, `.cache/`, `playwright-report/`, `test-results/`.
- Diretório `manual-associados/` (não versionado — aparece como untracked no `git status`) contém apenas capturas de tela (`.png`) usadas para montar um manual do usuário; não é código.

## Bibliotecas e SDKs (dependências)

### Runtime do site (sem gerenciador de pacotes — tudo via CDN ou vendorizado em `assets/`)
| Biblioteca | Fonte | Uso |
|---|---|---|
| Firebase SDK modular v11.0.1 | CDN `www.gstatic.com/firebasejs/11.0.1/` | Auth, Firestore, Storage, Functions |
| Bootstrap 5.3.3 | Vendorizado em `assets/css/bootstrap.min.css` + `assets/js/bootstrap.bundle.min.js` | Layout, componentes, modais |
| Bootstrap Icons 1.11.3 | CDN `cdn.jsdelivr.net` | Ícones |
| QRCode.js 1.5.3 | CDN `cdn.jsdelivr.net/npm/qrcode@1.5.3` | Geração do QR Code de check-in (`event_comprovante.html`) |
| jsPDF + autoTable | CDN (usado em `admin_inscricoes.html`, exportações de `admin_associados.html`) | Exportação de listas em PDF |

### `package.json` (raiz) — apenas testes
```json
{
  "devDependencies": { "@playwright/test": "^1.60.0", "serve": "^14.2.6" }
}
```

### `functions/package.json` — backend
```json
{
  "engines": { "node": "22" },
  "dependencies": {
    "@google-cloud/secret-manager": "^6.1.1",
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^4.9.0",
    "nodemailer": "^8.0.5"
  }
}
```
Nenhuma dependência de framework HTTP (Express) — as funções `onRequest` (`asaasWebhook`, `auctionAsaasWebhook`) usam a API nativa do `firebase-functions` v1 diretamente.

## Custos de infraestrutura (visão geral)

Ver detalhamento em [PERFORMANCE.md](PERFORMANCE.md) §Custos. Resumo dos geradores de custo:
- Firestore: leituras/escritas por página carregada (a maioria das páginas públicas faz 1-3 leituras de coleção por visita) + `onSnapshot` ativos (classificados, financeiro do associado, leilões).
- Cloud Functions: invocações por evento de negócio + 4 cron jobs (destaque: `encerrarLotesExpirados` roda **a cada 1 minuto**, 1440 invocações/dia, mesmo sem nenhum lote para encerrar).
- Storage: armazenamento de imagens comprimidas (~150-300 KB cada, alvo variável por módulo) + banda de download (leitura pública, sem cache-control agressivo em todos os paths).
- Asaas: cobra por transação processada (fora do controle deste repositório, ver contrato comercial com Asaas).
