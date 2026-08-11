# Performance e Custos

## Consultas e leituras Firestore por página (destaques)

| Página | Padrão de leitura | Observação de custo |
|---|---|---|
| `index.html` | `getDoc(users/{uid})` + `getDocs(cms_banners)` + `getDocs(cms_partners)` | 1x por carregamento (sem `onSnapshot`) — barato |
| `classificados.html` | `onSnapshot` permanente (lista) + `onSnapshot` (finance/summary, se logado) + `getDocs` em 3 coleções para destaques | Listener persistente cobra 1 leitura por documento afetado a cada mudança, enquanto a aba estiver aberta — o mais "caro" das páginas públicas |
| `gallery.html` | `getDocs(cms_gallery)` + N×`getDocs(fotos)` sequencial (loop `for...of`) | **N+1 queries** — cresce linearmente com o nº de álbuns; sem paralelização (`Promise.all` resolveria sem mudar comportamento) |
| `pg_associado.html` | `getDoc`/`getUserProfile` + `onSnapshot(finance/summary)` + `getDocs` (produtos/serviços/classificados para destaques) + `getDocs(eventRegistrations)` | Múltiplas leituras por carregamento, mas sem listener de lista grande |
| `leiloes.html` | 2× `onSnapshot(auctionLots)` + `setInterval` de 30s só para re-render local (não gera leitura nova) | Listener duplo permanente — custo proporcional ao nº de lotes ativos/encerrados recentes |
| `leilao_lote.html` | `onSnapshot(lote)` + `onSnapshot(bids, limit 50)` | Tempo real necessário para lances — custo justificado pelo caso de uso |
| `admin_associados.html` | `getDocs(users)` **sem paginação**, toda a organização de uma vez | Cresce linearmente com o nº de associados; para organizações grandes, é o ponto de maior custo/latência do sistema |
| `admin_leiloes.html` | Múltiplos `onSnapshot` (4 abas) + `getDocs` sob demanda para lances individuais | Listeners paralelos quando o admin deixa a aba aberta |

## Escritas

- A maioria das escritas é pontual (CRUD administrativo, cadastro, lance). O ponto de maior volume de escrita é `placeBid` (1 escrita em `bids` + 1 `updateDoc` no lote por lance, dentro de transação) e o cron `encerrarLotesExpirados` (batch de todos os lotes vencidos a cada execução).

## Cloud Functions — frequência de invocação

| Função | Frequência | Nota de custo |
|---|---|---|
| `encerrarLotesExpirados` | **A cada 1 minuto**, 24/7 (1440 invocações/dia) | Roda mesmo quando não há nenhum lote para encerrar — candidato natural a otimização (ver [TECH_DEBT.md](TECH_DEBT.md)), embora o custo absoluto seja baixo (função rápida, poucas leituras se não há lotes) |
| `asaasReconciliationDaily` | 1x/dia (04:00 BRT) | Custo proporcional ao nº de associados ativos com assinatura |
| `sendDailyPaymentReport` | 1x/dia (08:00 BRT) | Lê toda a coleção `users` + subcoleções financeiras de cada um — custo cresce com a base |
| `verificarInadimplentesDiarios` | 1x/dia (09:00 BRT) | Proporcional ao nº de `auctionPayments` pendentes |
| `placeBid`, webhooks, callables administrativos | Sob demanda | Proporcional ao uso real |

## Storage

- Imagens comprimidas no cliente antes do upload (150-600 KB conforme módulo, ver [STORAGE.md](STORAGE.md)) — reduz significativamente custo de armazenamento e banda comparado a upload de fotos de câmera sem compressão (tipicamente 2-8 MB).
- `cacheControl: public, max-age=31536000, immutable` em todos os uploads — evita reservir a mesma imagem repetidamente ao mesmo cliente; como o nome do arquivo é sempre único (timestamp), não há risco de servir uma versão desatualizada.
- **Imagens órfãs**: `admin_produtos.html` não apaga o blob do Storage ao remover uma imagem do array `imageUrls` — acumula custo de armazenamento ao longo do tempo (baixo valor absoluto, dado o tamanho comprimido, mas seria zero-custo corrigir).

## Bootstrap/JavaScript

- Sem bundler — cada página carrega Bootstrap CSS/JS vendorizado localmente (sem round-trip de CDN para esses dois arquivos, reduzindo pontos de falha externos), mais Bootstrap Icons via CDN jsdelivr.
- `assets/js/main.js` é um stub vazio — nenhum custo, mas também nenhuma otimização de UI compartilhada (cada página reimplementa sua própria lógica de navbar/menu mobile onde necessário).
- Sem minificação observada nos arquivos HTML/JS inline das páginas (só as libs vendorizadas — `bootstrap.min.css`, `bootstrap.bundle.min.js` — já vêm minificadas).

## Cache

- Ver Storage acima. Não há Service Worker/cache offline configurado (sem `manifest.json`/PWA observado).
- GitHub Pages aplica seu próprio cache de CDN para os arquivos estáticos do site (comportamento padrão da plataforma, fora do controle do repositório).

## Lazy Loading / Paginação

- **Não há paginação real** em nenhuma listagem observada (associados, classificados, lotes de leilão) — todas carregam o conjunto completo (filtrado por `orgId`/status) de uma vez. Para o volume atual (um clube local), isso é aceitável; se o número de associados/lotes crescer significativamente, será o primeiro ponto a exigir paginação (`startAfter`/`limit`) ou `getCountFromServer` combinado com paginação sob demanda (já usado parcialmente em `admin_conteudo.html` para contadores).
- `leilao_lote.html` já limita o histórico de lances a `limit(50)` — bom padrão pontual.
- `leiloes.html` já corta lotes encerrados a 12 no cliente (mas ainda busca todos via `onSnapshot` antes de cortar — o corte é só de renderização, não de leitura).

## Índices

Ver lista completa em [DATABASE.md](DATABASE.md)#índices-compostos. Todos os índices necessários para as queries observadas parecem estar declarados em `firestore.indexes.json` (27 índices) — não foram encontradas queries client-side que precisassem de índice composto e não tivessem correspondência no arquivo, com uma ressalva: `admin_master_faturamento.html`/`admin_master.html` usam `orderBy` simples de campo único (não exigem índice composto).

## Recomendações de baixo esforço para reduzir custo

1. Trocar `encerrarLotesExpirados` de `every 1 minutes` para um intervalo maior (ex. 5 minutos) se a precisão de encerramento a cada minuto não for um requisito de negócio crítico — reduz invocações de 1440/dia para ~288/dia.
2. Paralelizar a busca de fotos por álbum em `gallery.html` com `Promise.all` em vez de `for...of` sequencial.
3. Implementar `deleteObject` também em `admin_produtos.html` ao remover imagem (paridade com `admin_servicos.html`).
4. Quando o número de associados crescer, adicionar paginação a `admin_associados.html` (a lógica de "gestão por exceção" já agrupa em tiers, o que facilita paginar por tier em vez do total).
