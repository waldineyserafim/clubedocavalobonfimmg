# Funcionalidades — Catálogo Completo por Módulo

> **Nota de escopo (agosto de 2026)**: levantamento de 2026-07-21 — não cobre `admin_configuracoes.html` (autoatendimento de configuração de negócio pelo Organization Master, Fase 4), nem o mecanismo de Feature Flags (Fase 3.8, `portal-associativo/CLAUDE.md`). Módulos administrados pelo Painel Master de plataforma (planos, assinaturas, domínios) estão fora do escopo deste catálogo — ver `portal-associativo/CLAUDE.md`.

Convenção usada em cada item: **Objetivo**, **Fluxo**, **Arquivos**, **Coleções**, **Regras/Permissões**, **Dependências**.

---

# Módulo: Público

## Home (`index.html`)
- **Objetivo**: landing institucional, hub de navegação para os módulos ativos.
- **Fluxo**: `applyModuleVisibility()` oculta nav de módulos desativados; busca `cms_banners`/`cms_partners` (via `getDocs`, filtro `orgId`) para sobrescrever carrossel/parceiros estáticos; `onAuthStateChanged` decide exibir botão "Dashboard" se `role==="admin"`.
- **Coleções**: `cms_banners`, `cms_partners`, `users/{uid}` (leitura), `organizations/{orgId}` (via `checkModuleEnabled`).
- **Permissões**: pública.
- **Dependências**: Bootstrap, Bootstrap Icons.

## Sobre o Clube (`sobre.html`)
- **Objetivo**: institucional (missão, planos, dados legais/CNPJ).
- **Fluxo**: lê `cms_about/{currentOrgId}` (documento único) e sobrescreve textos estáticos via `innerHTML`.
- **Coleções**: `cms_about`.
- **Permissões**: pública.

## Diretoria (`board.html`)
- **Objetivo**: exibir membros da diretoria/conselhos.
- **Fluxo**: `checkModuleEnabled("diretoria")`; busca `cms_board` filtrado por `orgId`, agrupado por `categoria`, ordenado por `ordem`; oculta fallback estático se houver dados dinâmicos.
- **Coleções**: `cms_board`.
- **Permissões**: pública.

## Parceiros (`partners.html`)
- **Objetivo**: vitrine de patrocinadores/parceiros.
- **Fluxo**: `checkModuleEnabled("parcerias")`; busca `cms_partners`.
- **Coleções**: `cms_partners`.
- **Permissões**: pública.

## Eventos públicos (`events.html`)
- **Objetivo**: agenda de eventos do clube.
- **Fluxo**: `checkModuleEnabled("eventos")`; busca `cms_events` (filtro `orgId`, `ativo && !deleted`, ordenado por `data` no cliente); botão de inscrição condicional a `permiteInscricao` + prazo (`dataEncerramento`) não vencido, linkando para `event_inscricao.html?eventoId=`.
- **Coleções**: `cms_events`.
- **Permissões**: pública.

## Galeria (`gallery.html`)
- **Objetivo**: álbuns de fotos.
- **Fluxo**: `checkModuleEnabled("galeria")`; busca `cms_gallery` (álbuns) e, para cada álbum, a subcoleção `fotos` (sequencialmente); lightbox customizado com navegação por teclado.
- **Coleções**: `cms_gallery`, `cms_gallery/{albumId}/fotos`.
- **Permissões**: pública.
- **Bug conhecido**: `gallery.html:198` referencia variável inexistente (`albums` em vez de `albumsRaw`) — gera erro no console sem quebrar a funcionalidade visível (ver [TECH_DEBT.md](TECH_DEBT.md)).

## Classificados públicos (`classificados.html`)
- **Objetivo**: marketplace de anúncios entre associados, visível a qualquer visitante.
- **Fluxo**: listagem em tempo real (`onSnapshot`) com filtro `orgId+active+approved+paymentStatus` + busca client-side; carrossel de destaques (`getDocs` em `memberClassifieds`/`classificados`/`classifieds`, filtrando `destaque`/`featured`/`isFeatured`); se logado, "strip financeira" (nome/plano/status) com `onSnapshot` em `finance/summary`; cadastro via modal (só se `auth.currentUser` existir) com upload de até 3 fotos comprimidas (~200KB) e criação em `memberClassifieds` com `active:false, approved:false, paymentStatus:"pending"` (aguardando moderação e cobrança de exibição, R$1/dia mín. 30 dias).
- **Coleções**: `memberClassifieds` (+ leitura de compatibilidade em `classificados`/`classifieds`), `users/{uid}`, `users/{uid}/finance/summary`.
- **Permissões**: leitura pública; criação exige login (checagem simples, não `requireAuth`).
- **Dependências**: `bootstrap.Carousel`.

## Inscrição em evento (`event_inscricao.html`)
- **Objetivo**: formulário público de inscrição via link com `?eventoId=`.
- **Fluxo**: lê `cms_events/{eventoId}` para validar existência/prazo/vagas; chama Cloud Function `createEventRegistration({eventoId, cpf, nome, telefone})`; trata resposta (duplicidade → mostra comprovante existente; erro "INADIMPLENTE" → aponta para `pay.html`; erro de prazo → estado de encerrado).
- **Coleções**: `cms_events` (leitura); escrita em `eventRegistrations` feita **só** pela Cloud Function.
- **Permissões**: pública, sem login (validação de "sócio em dia" feita no backend por CPF).
- **Cloud Function**: `createEventRegistration`.

## Comprovante de inscrição (`event_comprovante.html`)
- **Objetivo**: exibir comprovante + QR Code de check-in.
- **Fluxo**: lê `eventRegistrations/{regId}` e valida `viewToken` da query string contra o gravado no documento (controle de acesso por posse de token, sem login); gera QR Code (`QRCode.toCanvas`) apontando para `event_checkin.html?token={reg.token}` (token diferente do de visualização); suporta impressão e "copiar link".
- **Coleções**: `eventRegistrations`, `cms_events` (complemento).
- **Permissões**: pública, controlada por token na URL.
- **Dependências**: QRCode.js (CDN).

## Check-in de evento (`event_checkin.html`)
- **Objetivo**: interface do staff para confirmar presença via QR Code/token manual.
- **Fluxo**: `requireAuth({requiredRole:[admin,master,operador,adminView]})`; lê `?token=` (originado do scan do QR); chama Cloud Function `confirmEventCheckin({token})`; renderiza 4 estados (confirmado/já confirmado/cancelado/inválido); "Próximo check-in" reseta a UI para escaneamento sequencial.
- **Coleções**: nenhuma leitura/escrita direta (delegada à Cloud Function).
- **Permissões**: exige login com role de staff — **nota de segurança**: a Cloud Function não replica essa checagem de role (ver [SECURITY.md](SECURITY.md) achado #1).
- **Cloud Function**: `confirmEventCheckin`.

---

# Módulo: Cadastro, Login e Pagamento

## Cadastro (`signup.html`)
Ver [AUTHENTICATION.md](AUTHENTICATION.md). Dois fluxos: Associado (`doSignupWithProfile`) e Participante de Leilão (`doSignupParticipanteLeilao`, com aceite obrigatório dos Termos do Comprador).

## Login (`login.html`)
Ver [AUTHENTICATION.md](AUTHENTICATION.md). CPF→e-mail sintético, roteamento pós-login por status financeiro (`pay.html?reason=inactive|pending` ou `pg_associado.html`).

## Login Master (`login_master.html`)
Login isolado (própria instância Firebase App) por e-mail real, restrito a `role==="master"`, usado pela Serafim Technologies para acessar `admin_master.html`.

## Redefinição de senha (`reset_senha.html`)
Ver fluxo completo em [AUTHENTICATION.md](AUTHENTICATION.md) e [FLOWS.md](FLOWS.md). Self-service via Firebase Phone Auth (SMS), rate-limited (5/hora/CPF), sem envolver a diretoria.

## Pagamento (`pay.html`)
- **Objetivo**: regularizar a fatura pendente/atrasada via Asaas.
- **Fluxo**: chama `getAsaasPaymentLink()` (Cloud Function); se em dia, mostra aviso; senão mostra valor/vencimento e um botão que **redireciona ao checkout hospedado do Asaas** (não há formulário de cartão embutido); `watchPayment()` monitora `finance/summary.lastPayment` via `onSnapshot` e redireciona a `pay-success.html` ao detectar confirmação (timeout de 10 min com opção de "verificar novamente", cobrindo boleto). Contém também o modal de cancelamento de assinatura (mesmo de `pg_associado.html`), pois um associado bloqueado por inadimplência cai sempre nesta tela e precisa poder cancelar sem acessar o dashboard.
- **Coleções**: `users/{uid}` (CPF/nome/planType), `users/{uid}/finance/summary`.
- **Cloud Functions**: `getAsaasPaymentLink`, `cancelMySubscription`.
- **Permissões**: exige login (checagem inline, não `requireAuth`).
- **Nota**: não há seleção de plano nesta tela — o plano já foi definido previamente pelo admin/diretoria.

## Confirmação de pagamento (`pay-success.html`)
Tela estática informativa, sem lógica de verificação ativa — assume que o webhook Asaas já processou ou processará a atualização.

---

# Módulo: Área do Associado

## Dashboard (`pg_associado.html`)
- **Objetivo**: hub central do associado logado.
- **Fluxo**: modal de primeiro acesso obrigatório (`primeiroAcesso`); bloqueio antecipado por inadimplência (>5 dias de atraso → redirect `pay.html?reason=overdue_block`, checado **antes** de renderizar); badge de status financeiro em tempo real (`onSnapshot` em `finance/summary`); modal de cancelamento de assinatura em 2 passos (confirmar CPF+telefone → mostrar vigência e confirmar) chamando `cancelMySubscription`; botão de reativação chamando `reactivateMySubscription`; carrossel de destaques (produtos/serviços/classificados); lista de "minhas inscrições" em eventos.
- **Coleções**: `users/{uid}`, `users/{uid}/finance/summary`, `memberProducts`, `memberServices`, `classificados`/`memberClassifieds`, `eventRegistrations`.
- **Cloud Functions**: `cancelMySubscription`, `reactivateMySubscription`.
- **Permissões**: qualquer autenticado.
- **Nota**: há código órfão de criação de classificado direto pelo dashboard (`#classifiedModal` referenciado no JS, mas o HTML do modal não existe no arquivo) — ver [TECH_DEBT.md](TECH_DEBT.md).

## Produtos exclusivos (`produtos_associado.html`)
- **Objetivo**: vitrine de produtos com condições especiais para associados.
- **Fluxo**: `checkModuleEnabled("produtos")`; busca `memberProducts` (`orgId+active`); busca textual client-side; card com carrossel de imagens, preço, botão WhatsApp.
- **Coleções**: `memberProducts`, `users/{uid}`, `users/{uid}/finance/summary`.
- **Permissões**: autenticado.

## Serviços exclusivos (`servicos_associado.html`)
Estrutura idêntica a Produtos, sem campo de preço, coleção `memberServices`.

---

# Módulo: Leilões

## Listagem pública (`leiloes.html`)
- **Objetivo**: vitrine de lotes em leilão.
- **Fluxo**: `checkModuleEnabled("leiloes")`; dois listeners `onSnapshot` (lotes `publicado` e lotes encerrados, cortados a 12); filtros de status/categoria/busca; countdown ao vivo; CTA de "cadastrar lote"/"meus lotes" só para `associado|admin|master` (não `participanteLeilao`).
- **Coleções**: `auctionLots`.
- **Permissões**: pública para visualizar; ações exigem login.

## Detalhe do lote / lances (`leilao_lote.html`)
- **Objetivo**: página do lote, dar lances.
- **Fluxo**: `onSnapshot` no doc do lote + na subcoleção `bids` (últimos 50); countdown; formulário de lance visível só se logado, `status==="publicado"` e não é o próprio vendedor; modal de Termos do Comprador na primeira vez (gravado em `localStorage`); `submitBid()` chama Cloud Function `placeBid({lotId, amount})` — toda a validação/gravação do lance é server-side e transacional.
- **Coleções**: `auctionLots/{lotId}`, `auctionLots/{lotId}/bids` (leitura apenas — escrita bloqueada por regra, só a function grava).
- **Cloud Function**: `placeBid`.
- **Permissões**: visualização pública; lance exige login e `inadimplenteLeilao!==true`.

## Cadastro de lote (`lote_form.html`)
- **Objetivo**: associado cadastra/edita um lote (rascunho ou envio para aprovação).
- **Fluxo**: campos dinâmicos por categoria (animal/genética/produto); upload de até 8 fotos + até 3 links de vídeo; Termo de Responsabilidade obrigatório só para enviar à aprovação (rascunho pode ser salvo sem aceitar); `saveLot(status)` grava `rascunho` ou `em_analise` em `auctionLots`.
- **Coleções**: `auctionLots` (create/update), `users/{uid}` (nome do vendedor).
- **Storage**: `auctionLots/{uid}/...`.
- **Permissões**: `associado|admin|master` (não `participanteLeilao`).

## Meus lotes (`meus_lotes.html`)
- **Objetivo**: gestão dos próprios lotes.
- **Fluxo**: `onSnapshot` filtrado por `sellerUid`; ações condicionais por status: editar (`rascunho|rejeitado`), enviar para aprovação (`rascunho→em_analise`), cancelar (`rascunho→cancelado`), ver/compartilhar lote público.
- **Coleções**: `auctionLots` (update de status).
- **Permissões**: `associado|admin|master`.

Ver máquina de estados completa e diagramas em [FLOWS.md](FLOWS.md), e detalhamento administrativo em [ADMIN.md](ADMIN.md).

---

# Resumo de dependências por módulo

| Módulo | Cloud Functions | Coleções principais | CDN extra |
|---|---|---|---|
| Público/CMS | — (leitura direta) | `cms_*` | — |
| Cadastro/Login | (via `firebase.js`) | `users` | — |
| Redefinição de senha | `startPasswordReset`, `completePasswordReset` | `users`, `passwordResetAttempts` | Firebase Phone Auth (RecaptchaVerifier) |
| Pagamento | `getAsaasPaymentLink`, `cancelMySubscription`, `reactivateMySubscription` | `users/finance`, `financeInvoices` | — |
| Área do associado | idem + | `memberProducts`, `memberServices`, `memberClassifieds`, `eventRegistrations` | — |
| Eventos | `createEventRegistration`, `confirmEventCheckin` | `cms_events`, `eventRegistrations` | QRCode.js |
| Leilões | `placeBid`, `gerarCobrancaLeilao`, `liberarRepasse` | `auctionLots`, `bids`, `auctionSales`, `auctionPayments`, `auctionNotifications` | — |
| Administração | ver [ADMIN.md](ADMIN.md) | todas | jsPDF/autoTable |
