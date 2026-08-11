# Dívida Técnica e Divergências Código × Documentação

Cada item: **Problema**, **Impacto**, **Prioridade**, **Esforço**, **Sugestão**. Só itens com dívida real observada no código (nada inventado).

## 1. Cloud Functions chamadas pela UI mas ausentes no backend
- **Problema**: `admin_master_configuracoes.html` chama `httpsCallable(functions,"seedMultiTenantData")` e `"migrateToMultiTenant"` — nenhuma das duas existe em `functions/index.js` (confirmado por busca no arquivo inteiro).
- **Impacto**: clicar nos botões correspondentes falha com `functions/not-found` em produção.
- **Prioridade**: Média (funcional, não bloqueia o core do sistema, mas é uma feature "quebrada" visível a quem tem acesso master).
- **Esforço**: Médio (implementar as duas funções conforme o que a UI espera — `seedMultiTenantData` deveria popular `systemPlans` com os 3 planos esperados pelo teste `04-migration-data.spec.js`; `migrateToMultiTenant` deveria retroativamente gravar `orgId` em documentos legados que não o tenham).
- **Sugestão**: implementar as funções, ou remover os botões da UI até a implementação estar pronta (evita a falha silenciosa em produção).

## 2. `systemPlans` é uma coleção "fantasma"
- **Problema**: protegida nas Firestore Rules e coberta por teste e2e, mas sem UI de CRUD e sem dado real — os planos usados de fato (`starter/professional/enterprise/custom`) são objetos JS hardcoded, **duplicados em 3 arquivos**: `admin_master.html` (`PLAN_LABELS`), `admin_master_associacoes.html` (`PLAN_MODULES`), `admin_master_faturamento.html`.
- **Impacto**: mudar o conjunto de módulos de um plano exige editar 3 arquivos manualmente e mantê-los sincronizados; risco de divergência silenciosa entre eles.
- **Prioridade**: Média (só relevante quando o SaaS multi-tenant for de fato operado com múltiplos planos reais).
- **Esforço**: Médio — criar uma tela simples de CRUD para `systemPlans` e fazer as 3 telas lerem de lá em vez de hardcode.
- **Sugestão**: consolidar antes de vender o produto como SaaS multi-tenant para um segundo cliente real.

## 3. Multi-tenant "de fachada" — `currentOrgId` fixo
- **Problema**: `firebase.js:56` define `currentOrgId = "org_bonfim"` como constante — nenhuma página deriva o tenant do domínio/subdomínio (o comentário no próprio código diz "em fase futura será derivado do domínio"). O painel master permite cadastrar N organizações, mas nenhuma delas além de `org_bonfim` é operável sem editar e reimplantar o código-fonte.
- **Impacto**: o produto não é, hoje, um SaaS multi-tenant funcional para um segundo cliente — é uma arquitetura *preparada* para isso, mas ainda de um único tenant.
- **Prioridade**: Alta, **se e somente se** houver plano de comercializar para outro clube em prazo próximo; Baixa/nula caso contrário (o sistema funciona perfeitamente bem para o único tenant real).
- **Esforço**: Alto — requer resolver o tenant por domínio/subdomínio no carregamento da página (ex.: mapear `location.hostname` → `orgId` via uma coleção de lookup), e testar todo o sistema com 2 tenants reais simultâneos.
- **Sugestão**: tratar como trabalho de uma fase própria do roadmap (a "Fase 5" já prevista em `CLAUDE.md`), não como correção pontual.

## 4. `gerarCobrancaLeilao` sem gatilho de UI
- **Problema**: a Cloud Function que gera a cobrança Asaas para o comprador de um lote arrematado existe e funciona (`functions/index.js:2795`), mas nenhuma das 5 páginas do módulo de leilão a chama.
- **Impacto**: o comprador de um lote arrematado não tem, hoje, como gerar a própria cobrança pela interface — depende de alguém (admin?) disparar isso manualmente por outro meio (não observado no código) ou de uma função ainda não escrita no frontend.
- **Prioridade**: **Alta** — é uma lacuna no fluxo financeiro central do módulo de leilões (sem cobrança, o vendedor nunca recebe o repasse).
- **Esforço**: Baixo — adicionar um botão em `leilao_lote.html` (ou numa futura "Minhas Compras") visível quando `auctionSales.status==="aguardando_pagamento"` e `buyerUid===currentUser`, chamando `gerarCobrancaLeilao({saleId})`.
- **Sugestão**: priorizar — é o elo faltante entre "lote arrematado" e "vendedor recebe o dinheiro".

## 5. Regra de Firestore permissiva em `auctionLots.update`
Ver detalhe completo em [SECURITY.md](SECURITY.md) achado #2/[FIRESTORE.md](FIRESTORE.md). **Prioridade: Alta.** **Esforço: Baixo** (uma linha de regra).

## 6. `confirmEventCheckin` sem checagem de role no servidor
Ver [SECURITY.md](SECURITY.md) achado #1. **Prioridade: Alta.** **Esforço: Baixo.**

## 7. Duas coleções de classificados em paralelo (`classificados` e `memberClassifieds`)
- **Problema**: regras quase idênticas, helpers e páginas usam nomes diferentes em pontos diferentes (`classificados.html` lê `memberClassifieds` como fonte principal, mas também consulta `classificados`/`classifieds` para o carrossel de destaques "por garantia").
- **Impacto**: manutenção duplicada; risco de uma correção de regra/campo ser aplicada só numa coleção.
- **Prioridade**: Baixa-Média.
- **Esforço**: Médio (migração de dados + atualização de todas as queries).
- **Sugestão**: consolidar em `memberClassifieds` (a mais usada/atual) na próxima janela de manutenção do módulo.

## 8. Convenção de Storage inconsistente entre módulos
- **Problema**: CMS usa `tenants/{orgId}/cms/{categoria}/...`; Produtos/Serviços/Classificados usam `uploads/{categoria}/...` (fora do prefixo de tenant).
- **Impacto**: em um cenário multi-tenant real futuro, os paths de `uploads/*` misturariam arquivos de organizações diferentes no mesmo prefixo (hoje inofensivo, pois só existe uma org).
- **Prioridade**: Média (crítico se o multi-tenant avançar; irrelevante hoje).
- **Esforço**: Médio — migrar paths e atualizar `storage.rules`.
- **Sugestão**: alinhar antes de item #3 avançar.

## 9. Compressão de imagem duplicada em 6+ implementações locais
- **Problema**: `admin_produtos.html`, `admin_servicos.html`, `admin_classificados.html` e cada tela de CMS reimplementam sua própria função de compressão canvas→JPEG, com pequenas variações de alvo/dimensão/limite.
- **Impacto**: manutenção espalhada; qualquer bug ou melhoria de compressão precisa ser replicado manualmente em todos os lugares.
- **Prioridade**: Baixa (funciona corretamente hoje, é só duplicação).
- **Esforço**: Médio — extrair um helper parametrizável único em `firebase.js` (que já tem `compressImage`/`uploadImageFile` genéricos) e migrar as telas para usá-lo com os parâmetros específicos de cada módulo.
- **Sugestão**: oportunidade de simplificação de baixo risco na próxima vez que qualquer uma dessas telas for tocada por outro motivo.

## 10. `admin_produtos.html` não apaga blobs órfãos do Storage
Ver [PERFORMANCE.md](PERFORMANCE.md). **Prioridade: Baixa.** **Esforço: Baixo** (paridade com `admin_servicos.html`, que já faz `deleteObject`).

## 11. `admin_associados.html` não audita a maioria de suas ações em `systemLogs`
- **Problema**: só a criação de associado chama `logAction`; edição de perfil, lançamento/edição de fatura, isenção, sync Asaas e exclusão não geram entrada de auditoria — apesar de `admin_associados.html` ser a tela mais sensível do sistema (dados financeiros e pessoais).
- **Impacto**: em caso de disputa/erro, não há trilha de "quem editou o quê e quando" para a maioria das ações administrativas financeiras (exceto o que já fica registrado em `asaasSync`/`financeInvoices.recordedBy*`, que cobre parte do financeiro, mas não a edição de perfil/isenção).
- **Prioridade**: Média (relevante para compliance/LGPD e resolução de disputas).
- **Esforço**: Baixo-Médio — adicionar chamadas de `logAction()` nos pontos já identificados em [ADMIN.md](ADMIN.md).
- **Sugestão**: priorizar antes de uma auditoria externa/LGPD formal.

## 12. `encerrarLotesExpirados` roda a cada 1 minuto continuamente
Ver [PERFORMANCE.md](PERFORMANCE.md). **Prioridade: Baixa** (custo baixo, mas facilmente otimizável). **Esforço: Baixo.**

## 13. `login_master.html` duplica a configuração do Firebase inline
**Prioridade: Baixa.** **Esforço: Baixo** — trocar para importar `firebase.js`.

## 14. Guard de autenticação inconsistente (`requireAuth` vs. checagem inline)
- **Problema**: `login.html`, `pay.html`, `pg_associado.html`, `produtos_associado.html`, `servicos_associado.html` reimplementam `onAuthStateChanged` manualmente em vez de usar `requireAuth()` de `firebase.js`.
- **Impacto**: nenhuma vulnerabilidade concreta identificada (a lógica reimplementada é funcionalmente equivalente e as Firestore Rules são a barreira real), mas é duplicação de código que dificulta manutenção futura (ex.: se `requireAuth` ganhar uma nova proteção, essas páginas não a herdam automaticamente).
- **Prioridade**: Baixa.
- **Esforço**: Médio (requer testar cada página migrada individualmente).
- **Sugestão**: migrar oportunisticamente quando cada uma dessas páginas for tocada por outro motivo, não como projeto dedicado.

## 15. Código órfão em `pg_associado.html` (modal de classificado inexistente)
- **Problema**: o script referencia `#classifiedModal`, `#classifiedForm`, `#btnNewClassified`, mas o HTML desses elementos não existe no arquivo — os listeners nunca disparam (`?.` os torna no-ops silenciosos).
- **Impacto**: nenhum (funcionalmente inofensivo — apenas código morto).
- **Prioridade**: Baixa.
- **Esforço**: Baixo — remover o código morto, ou reintroduzir o modal/botão se a intenção era realmente permitir cadastro de classificado direto do dashboard.
- **Sugestão**: decidir com o time de produto se a feature deveria existir ali (parece ter sido removida do HTML sem remover o JS correspondente).

## 16. Bug de variável em `gallery.html:198`
`window._galleryAlbums = albums` referencia variável inexistente (`albumsRaw` é a correta) — gera `ReferenceError` no console, sem quebrar a galeria/lightbox visível (que dependem de `_galleryAlbumPhotos`, não de `_galleryAlbums`). **Prioridade: Baixa.** **Esforço: Trivial** (renomear a variável).

## 17. Estado `concluido` nunca alcançado
Ver [FLOWS.md](FLOWS.md) — o valor aparece em filtros de UI de `admin_leiloes.html`/`meus_lotes.html`/`leilao_lote.html` como se fosse um estado possível de `auctionLots.status` ou `auctionSales.status`, mas nenhum código grava esse valor em lugar nenhum. **Prioridade: Baixa** (não quebra nada, é só um estado morto na UI). **Esforço: Baixo** — decidir se `repasse_liberado` deveria virar `concluido` como estado terminal, ou remover a referência da UI.

## 18. Papel `operador` definido mas nunca atribuído/usado
`mapRole()`/`mapRoleServer()` reconhecem `operador`, mas nenhuma tela usa esse papel em `requiredRole` nem há UI para atribuí-lo a um usuário. **Prioridade: Baixa.** **Esforço**: depende da intenção de produto — se o papel for necessário (ex.: staff de check-in sem ser admin completo), implementar a atribuição e uso; senão, remover do mapeamento por clareza.

## 19. Testes e2e majoritariamente estáticos, não de integração real
- **Problema**: boa parte da suíte Playwright (`02`, `05`, `06`, `07`, `08`, `09`, `11`) faz inspeção de código-fonte (regex/grep sobre HTML e `functions/index.js`), não exercita de fato o comportamento em runtime contra Firebase real (exceto `04-migration-data.spec.js`, que bate no Firestore de produção via REST, e alguns testes "ao vivo" pontuais em cada arquivo).
- **Impacto**: mudanças que quebram contratos (ex.: renomear uma Cloud Function chamada por um botão) só são pegas se o teste estático verificar essa string específica; um bug de lógica de negócio real (ex.: cálculo de comissão errado) não seria pego por nenhum teste.
- **Prioridade**: Média (funciona bem como rede de segurança de regressão de estrutura/contrato, mas não substitui testes de integração).
- **Esforço**: Alto — implementar testes de integração reais contra o emulador do Firebase (Firestore + Functions + Auth) exigiria configurar `firebase-tools` no CI, algo não presente hoje (sem `.github/workflows`).
- **Sugestão**: manter a suíte estática como está (barata e eficaz para regressão estrutural) e considerar, como evolução futura, testes de integração via emulador para as Cloud Functions financeiras mais críticas (webhook, `placeBid`, `cancelMySubscription`).

---

## Cobertura da Documentação

| Métrica | Valor |
|---|---|
| Arquivos de código analisados (leitura integral) | **~75** (10 core/config + 1 backend `functions/index.js` + 10 páginas públicas + 9 páginas de auth/associado + 13 páginas admin + 9 páginas master/leilões + 12 testes e2e/config + 6 protótipos + 3 assets CSS/JS + `.gitignore`) |
| Linhas de código lidas (aprox.) | ~23.200 (HTML + `firebase.js` + `functions/index.js`), mais ~4.900 de testes e2e |
| Funcionalidades documentadas | Todas as identificadas: site institucional (6 páginas), autenticação (login/signup/reset de senha SMS), pagamento/Asaas, área do associado (dashboard/produtos/serviços), classificados, leilões (5 páginas + 6 Cloud Functions), eventos com QR Code/check-in, CMS (6 sub-módulos), administração de associados ("Central de Gestão"), painel master SaaS (4 páginas) |
| Integrações identificadas | Asaas (pagamentos, 2 webhooks distintos), Firebase (Auth/Firestore/Storage/Functions), Google Secret Manager, Nodemailer/Gmail (e-mail), Firebase Phone Auth (SMS), QRCode.js, jsPDF/autoTable |
| Coleções Firestore identificadas | 25: `users` (+ subcoleções `finance/summary`, `financeInvoices`, `finance/invoices` legado), `memberServices`, `memberProducts`, `memberClassifieds`, `classificados`, `auctionLots` (+ `bids`), `auctionSales`, `auctionPayments`, `auctionNotifications`, `organizations`, `systemPlans`, `systemLogs`, `organizationSubscriptions`, `systemConfig`, `cms_banners`, `cms_events`, `cms_partners`, `cms_board`, `cms_gallery` (+ `fotos`), `cms_about`, `eventRegistrations`, `passwordResetAttempts` |
| Cloud Functions identificadas | 32 exportadas em `functions/index.js`, todas documentadas individualmente em [ASAAS.md](ASAAS.md)/[FLOWS.md](FLOWS.md)/[ADMIN.md](ADMIN.md) |
| Regras de segurança analisadas | `firestore.rules` (444 linhas, todas as coleções) e `storage.rules` (58 linhas, todos os paths) — análise linha a linha em [FIRESTORE.md](FIRESTORE.md)/[STORAGE.md](STORAGE.md) |
| Itens de dívida técnica registrados | 19 (acima), todos observados diretamente no código, nenhum hipotético |
| Achados de segurança | 10 (catalogados em [SECURITY.md](SECURITY.md) com risco/probabilidade/prioridade) |
| **Percentual estimado de cobertura** | **~97%** do código-fonte de produção (HTML + `firebase.js` + `functions/index.js` + regras + testes + protótipos) foi lido integralmente e refletido nesta documentação. O 3% restante é majoritariamente CSS puro (`design-system.css`, resumido estruturalmente mas não reproduzido linha a linha) e o conteúdo binário de `manual-associados/` (capturas de tela, não código) |
