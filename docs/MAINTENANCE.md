# Manutenção — Como Estender o Sistema

## Como adicionar uma nova página estática

1. Criar o arquivo `.html` na raiz do repositório (sem build step, é servido diretamente).
2. Copiar o esqueleto padrão de outra página do mesmo tipo (pública vs. área logada vs. admin) — reaproveitar `<head>` (Bootstrap, Bootstrap Icons, `design-system.css`, `custom.css`), navbar e footer, para manter a regressão de design system passando (`tests/e2e/05-design-system-regression.spec.js` varre **todas** as páginas HTML da raiz e exige essas referências).
3. Importar `./firebase.js` como `<script type="module">` e usar `requireAuth({requiredRole:[...]})` se a página exigir login/role — **preferir isso** à checagem manual inline usada por algumas páginas legadas (ver [TECH_DEBT.md](TECH_DEBT.md)), para manter consistência.
4. Se a página pertence a um módulo habilitável, marcar os elementos de navegação relevantes com `data-module="nome-do-modulo"` e chamar `applyModuleVisibility()`/`checkModuleEnabled("nome-do-modulo")` conforme o padrão das páginas existentes.
5. Adicionar o link da nova página nas navbars de onde fizer sentido, e conferir com `03-navigation.spec.js` (que varre links internos quebrados) e `06-firebase-dom-integrity.spec.js` (se a página tiver JS que dependa de ids específicos, considerar adicionar um teste de integridade correspondente).

## Como adicionar um novo módulo habilitável (padrão `data-module`)

1. Escolher uma chave curta (ex. `"loja"`), consistente com o padrão de `applyModuleVisibility()` (`firebase.js:392-402`, lista `mods = [...]`) — **adicionar a nova chave a essa lista** é obrigatório, senão `checkModuleEnabled` nunca é chamado para ela automaticamente no loop de `applyModuleVisibility`.
2. Adicionar o campo correspondente em `organizations/{orgId}.modules` (mapa de booleans) — hoje só editável via `admin_master_associacoes.html`.
3. Marcar os elementos de UI do novo módulo com `data-module="loja"`.
4. Se o módulo tiver página(s) admin dedicada(s), seguir o padrão de CRUD já usado (CMS com soft delete, ou catálogo com `active` toggle) conforme a natureza do dado.
5. Atualizar `MODULOS.md` (documentação de módulos do projeto) com a nova entrada, seguindo o formato existente (chave, admin, coleção Firestore, páginas públicas/restritas, descrição).

## Como adicionar uma nova coleção Firestore

1. Definir o schema (campos, tipos) em conjunto com quem for consumir a coleção — não há ferramenta de migração/schema formal, então a documentação (`DATABASE.md`) e comentários no código são a única fonte de verdade.
2. Adicionar a regra correspondente em `firestore.rules`, seguindo o padrão mais próximo do caso de uso:
   - Conteúdo institucional público (como `cms_*`): leitura pública, escrita `canOperate()`.
   - Dado de propriedade do usuário (como `memberClassifieds`): criação por `ownerUid`/`createdBy`==self, update do dono com campos sensíveis protegidos.
   - Dado só gravável por Cloud Function (como `auctionSales`/`bids`): `allow write: if false` — força todo escrever a passar pelo Admin SDK, o que dá controle total de validação/atomicidade no backend.
3. Se a coleção for consultada com filtro composto (mais de 1 `where`/`orderBy`), adicionar o índice em `firestore.indexes.json` **antes** de publicar a query em produção — senão a query falha em runtime com um link do Firebase Console para criar o índice manualmente (pode ser usado como atalho em desenvolvimento, mas deve ser formalizado no arquivo antes do deploy final).
4. Documentar a nova coleção em `DATABASE.md` (regra de projeto, `CLAUDE.md:8` item 8 — "Documentar novas coleções Firestore e integrações").
5. Fazer deploy das regras (`firebase deploy --only firestore:rules,firestore:indexes`) antes ou junto do deploy do frontend que passa a usá-la.

## Como adicionar uma nova integração externa (padrão observado com o Asaas)

1. Guardar toda credencial no **Secret Manager**, nunca em `process.env`/hardcoded — seguir o padrão `getSecret(secretPath)` já existente em `functions/index.js`.
2. Concentrar toda chamada à API externa em Cloud Functions — nunca chamar diretamente do browser (evita expor chave de API e permite validação/autorização centralizada).
3. Se a integração expuser um webhook, seguir o padrão de `asaasWebhook`/`auctionAsaasWebhook`: validar um token estático via header customizado E reconsultar a API de origem antes de confiar no payload (mitiga payload forjado mesmo com token estático).
4. Se a integração precisar de idempotência (evitar duplicar efeito em reprocessamento), usar uma chave de deduplicação análoga a `asaasPaymentId` — buscar por essa chave antes de criar um novo registro.
5. Documentar em `ASAAS.md` (ou um novo `NOME_DA_INTEGRACAO.md`) os endpoints usados, campos sincronizados e estratégia de reconciliação, seguindo a mesma estrutura.

## Como publicar em produção

Ver [DEPLOY.md](DEPLOY.md) — resumo: frontend é `git push` (sem build), backend/regras são `firebase deploy` manual. Não há CI/CD automatizado hoje.

## Convenções a preservar (para manter a "filosofia" do projeto)

- Sem framework de frontend, sem bundler — compatibilidade GitHub Pages é um requisito de produto, não apenas técnico.
- Compressão de imagem sempre client-side antes do upload.
- Nome de arquivo de Storage sempre único (timestamp + sufixo) — nunca reutilizar nome, para não precisar invalidar cache.
- Separação clara entre "desativação administrativa" (`ativo`) e mecanismos self-service do associado (`assinaturaCanceladaPeloAssociado`) — não misturar esses dois conceitos ao criar novas features de bloqueio/liberação de acesso.
- Toda operação financeira ou de exclusão de conta deve ser uma Cloud Function com checagem de role no servidor, nunca confiar só na Firestore Rule ou no frontend.
