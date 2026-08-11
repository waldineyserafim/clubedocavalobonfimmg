# Ambiente de Desenvolvimento Local

> **Atualizado — Fase 3.8 (2026-08-11).** Ao contrário do resto de `docs/` (ver aviso em [README.md](README.md)), este arquivo é mantido junto do código e reflete o estado atual. Se ele divergir do que você observa, é bug de documentação — não confie no resto da pasta pelo mesmo critério.

Este guia leva um desenvolvedor novo do zero a rodar a plataforma inteira localmente — Firestore, Auth, Cloud Functions e Storage emulados, com os 193 testes automatizados passando — sem tocar em nenhum dado de produção.

## Pré-requisitos

| Ferramenta | Versão | Por quê |
|---|---|---|
| [Node.js](https://nodejs.org) | **22.x** (`.nvmrc` na raiz) | Mesma runtime que `functions/package.json` declara (`engines.node: "22"`) — evita "funciona local, quebra no deploy". Se usa [nvm](https://github.com/nvm-sh/nvm): `nvm use` na raiz do repo. |
| npm | 10+ (vem com Node 22) | — |
| [Java](https://adoptium.net) | 11+ (qualquer LTS recente serve) | O **Firestore Emulator** e o **Storage Emulator** são executáveis Java por baixo do Firebase CLI — sem Java, `firebase emulators:start` falha silenciosamente pros serviços que dependem dele. |
| [Firebase CLI](https://firebase.google.com/docs/cli) | 15+ | `npm install -g firebase-tools` — ou use via `npx firebase-tools` se preferir não instalar globalmente. |
| Conta com acesso ao projeto Firebase `clubecavalobonfim` | — | Só necessário pra **deploy** (`firebase login`) — os emuladores e a suíte de testes funcionam 100% offline, sem login nenhum. |

### Instalando o Java (macOS/Homebrew)

O Firebase CLI só precisa de um binário `java` no `PATH` — não precisa ser "o Java do sistema".

```bash
brew install openjdk
```

`openjdk` do Homebrew é **keg-only** (não é linkado automaticamente, pra não conflitar com outras instalações de Java) — depois de instalar, adicione ao seu shell:

```bash
echo 'export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"' >> ~/.zshrc   # ou ~/.bashrc
source ~/.zshrc
java -version   # deve imprimir algo como "openjdk version ..."
```

(Linux: `apt install default-jdk` / `dnf install java-latest-openjdk` ou equivalente da sua distro. Windows: instalar via [Adoptium](https://adoptium.net) e garantir que `java` está no PATH.)

## Instalação

```bash
git clone <repo>
cd clubedocavalobonfimmg
nvm use              # se usa nvm — garante Node 22
npm install           # instala as deps da raiz (eslint, playwright) E as de functions/ (via postinstall)
```

`npm install` na raiz já dispara `postinstall` → `cd functions && npm install` — **não é preciso rodar `npm install` duas vezes manualmente.**

## Rodando localmente

```bash
npm run dev
```

Isso executa `firebase emulators:start --only firestore,auth,functions,storage` — sobe:

| Emulador | Porta | Usado por este projeto? |
|---|---|---|
| Firestore | 8080 | ✅ sim |
| Authentication | 9099 | ✅ sim |
| Functions | 5001 | ✅ sim |
| Storage | 9199 | ✅ sim |
| **Hosting** | — | ❌ **não usado** — o frontend (HTML/CSS/JS estático) é servido pelo GitHub Pages, não pelo Firebase Hosting (ver `CLAUDE.md`, regra de desenvolvimento 4). Não há `hosting` em `firebase.json` por isso — não é lacuna, é decisão de arquitetura documentada. |
| Emulator UI | 4000 | ✅ sim (abre sozinho, `http://localhost:4000`) |

Com os emuladores rodando, sirva as páginas estáticas num terminal separado (`npm run serve`, porta 3333) e configure `firebase.js`/`tenant.config.js` pra apontar pros emuladores se for testar o frontend interativamente contra dados locais — isso já é o que os testes automatizados fazem por baixo dos panos, mas para uso manual/exploratório no navegador é um passo à parte (fora do escopo deste guia; ver `firebase.js` pelos hosts de emulador esperados: `127.0.0.1:8080`/`127.0.0.1:9099`).

## Rodando os testes

```bash
npm test
```

Isso é `firebase emulators:exec --only firestore,auth,storage "cd functions && npm run test:all"` — sobe os emuladores necessários, roda as **193 verificações** (139 testes de unidade/integração via Admin SDK + 38 de Firestore Rules + 15 de Storage Rules-lookup, todos contra dado 100% local e descartável) e derruba os emuladores ao final, com o código de saída refletindo passou/falhou (fecha o loop pra CI).

Sub-comandos, se precisar rodar só uma parte (dentro de `functions/`, com os emuladores já de pé via `npm run dev` num outro terminal):

```bash
cd functions
npm test                 # só os testes de unidade/integração (Admin SDK, ignora Rules)
npm run test:rules        # só Firestore Rules (client SDK real, aplica as regras de verdade)
npm run test:storage-rules # só Storage Rules
npm run test:all          # os três em sequência
```

## Lint e verificação de sintaxe

```bash
npm run lint    # ESLint — functions/**, firebase.js, tenant.config.js (ver eslint.config.js pro porquê do escopo)
npm run build   # substitui "build": não há bundler neste projeto (GitHub Pages serve estático,
                # Cloud Functions roda o .js como está) — "build" aqui é node --check em todo .js do repo,
                # o equivalente honesto de "quebrou o build" numa stack sem etapa de compilação.
```

## Solução de problemas

**`Error: Process 'java -version' has exited with code 1` ao rodar `npm run dev`/`npm test`**
Java não está no PATH desta sessão de shell. Confirme com `java -version`; se falhar, revise a seção "Instalando o Java" acima — o erro mais comum é ter instalado via `brew install openjdk` mas esquecido do `export PATH` (keg-only não se auto-linka).

**`EADDRINUSE` / porta ocupada ao subir os emuladores**
Outra instância dos emuladores já está rodando (ou travou de uma execução anterior). `firebase emulators:start` mostra qual porta; mate o processo (`lsof -i :8080` pra achar o PID) ou rode `firebase emulators:start --only <serviço>` só com o que precisa.

**`Cannot find module 'firebase-admin'` (ou outro pacote) dentro de `functions/`**
`functions/` tem `package.json`/`node_modules` **próprios**, separados da raiz (convenção do Firebase Functions). Rode `cd functions && npm install`, ou simplesmente `npm install` na raiz (o `postinstall` já faz isso por você).

**Testes de Rules (`test:rules`/`test:storage-rules`) dão `ECONNREFUSED 127.0.0.1:8080` quando rodados sozinhos**
Esses dois scripts **não sobem emulador nenhum** — esperam um Firestore/Storage Emulator já rodando (por isso `npm test`/`npm run test:all` os envolve em `firebase emulators:exec`). Rodá-los soltos só funciona se você já tiver `npm run dev` ativo num outro terminal.

**Node local é diferente da versão 22 que `functions/engines` declara**
Não impede os testes/emuladores de funcionar (o Admin SDK e o código deste projeto não usam nenhuma API exclusiva do Node 22), mas pode mascarar um comportamento que só aparece na runtime real do Cloud Functions no deploy. Prefira `nvm use` (lê o `.nvmrc` da raiz) pra eliminar essa variável.

**`npm run test:e2e` (Playwright) não faz parte de `npm test`/CI**
Decisão deliberada — a suíte e2e roda contra o **site publicado de verdade** (não os emuladores) e tem uma baseline conhecida de falhas intermitentes (ver `CLAUDE.md`, Fase 3.6). Incluir isso como gate de merge trocaria "impedir código quebrado" por "bloquear todo PR por instabilidade de rede/terceiros" — o oposto do objetivo. Rode manualmente quando for relevante: `npm run test:e2e`.

## O que cada emulador cobre (e o que não é usado)

- **Firestore + Auth**: usados por praticamente toda a suíte de testes (139 testes de `functions/test/*.test.js` via Admin SDK, que **ignora** Rules — testa só lógica de negócio) e pelas Rules (`rules.test.js`, via `@firebase/rules-unit-testing`, que aplica as regras de verdade).
- **Storage**: usado só por `storage-rules.test.js` (12 testes de política de upload por organização).
- **Functions**: emulado por `npm run dev` pra desenvolvimento/depuração interativa (`http://localhost:5001`), mas os testes automatizados **não** chamam as Cloud Functions via HTTP — importam `functions/index.js` direto e invocam a lógica interna contra Firestore/Auth emulados (mais rápido, sem precisar simular trigger/HTTP de verdade). Isso é uma limitação conhecida: os `exports.*` (o "encaixe" com `functions.https.onCall`/`onRequest`/Firestore triggers em si) não são exercitados pelos testes — só a lógica que eles chamam por dentro. Ver `docs/TECH_DEBT.md` (stale, mas o padrão de teste não mudou desde então).
- **Hosting**: não usado — ver tabela acima.
