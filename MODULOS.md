# CCBMG — Especificação de Módulos

**Clube do Cavalo de Bonfim MG**
Sistema de Gestão de Clubes e Associações — Serafim Technologies

---

## Visão Geral

O sistema é organizado em módulos que podem ser habilitados ou desabilitados por organização, sem necessidade de alteração de código. A configuração fica no documento `organizations/{orgId}` no Firestore, campo `modules: { nomeDoModulo: boolean }`.

A função `applyModuleVisibility()` em `firebase.js` lê essa configuração e oculta automaticamente todos os elementos HTML marcados com `data-module="nomeDoModulo"` quando o módulo está desabilitado.

---

## Módulos do Sistema

### 1. Associados
**Chave:** `associados`
**Admin:** `admin_associados.html`
**Coleção Firestore:** `users`, `users/{uid}/finance/summary`, `users/{uid}/financeInvoices`

Módulo central do sistema. Gerencia o cadastro completo dos associados: dados pessoais (nome, CPF, telefone, endereço), controle de acesso por roles (`master`, `admin`, `associado`), status de atividade e bloqueio. Inclui o fluxo de primeiro acesso com troca de senha obrigatória quando o admin cria a conta. Exibe no painel admin a listagem completa dos associados com busca, filtros e edição inline.

---

### 2. Financeiro
**Chave:** `financeiro`
**Admin:** `admin_associados.html` (aba Financeiro) + `pay.html`
**Coleção Firestore:** `users/{uid}/finance/summary`, `users/{uid}/financeInvoices`

Controla a situação financeira de cada associado: vigência da associação (`activeUntil`), data do próximo vencimento (`nextDue`), histórico de faturas (`financeInvoices`) e saldo devedor. Integrado diretamente ao Asaas (planos Mensal R$30 / Trimestral R$85 / Semestral R$170). O admin pode marcar faturas como pagas manualmente; o webhook do Asaas atualiza automaticamente quando o pagamento é feito pelo associado. Associados inadimplentes por mais de 10 dias são redirecionados para a tela de pagamento.

---

### 3. Eventos
**Chave:** `eventos`
**Admin:** `admin_eventos.html`
**Coleção Firestore:** `cms_events`
**Páginas públicas:** `events.html`

Calendário de eventos do clube: competições, cavalgadas, clínicas e leilões. Cada evento possui título, descrição, data, local e imagem. Exibe link "Eventos" na navbar e botão "Próximos eventos" no hero da home. O admin pode criar, editar, ativar/inativar e excluir eventos via painel CMS.

---

### 4. Classificados
**Chave:** `classificados`
**Admin:** `admin_classificados.html`
**Coleção Firestore:** `classificados` (ou `memberClassifieds`)
**Páginas públicas:** `classificados.html`

Marketplace de anúncios do clube, visível para qualquer visitante. Apenas associados autenticados podem publicar. Cada anúncio possui título, descrição, imagens, preço e contato via WhatsApp. O admin modera os anúncios (aprovação/reprovação). Associados podem publicar e gerenciar seus próprios classificados a partir do dashboard (`pg_associado.html`).

---

### 5. Produtos Exclusivos
**Chave:** `produtos`
**Admin:** `admin_produtos.html`
**Coleção Firestore:** `memberProducts`
**Páginas restritas:** `produtos_associado.html`

Catálogo de produtos com condições especiais disponíveis exclusivamente para associados autenticados. Cada produto tem título, descrição, benefício para o associado, galeria de imagens, preço e contato WhatsApp. Visível apenas na área logada; oculto para visitantes não cadastrados.

---

### 6. Serviços Exclusivos
**Chave:** `servicos`
**Admin:** `admin_servicos.html`
**Coleção Firestore:** `memberServices`
**Páginas restritas:** `servicos_associado.html`

Diretório de prestadores de serviço com condições especiais para associados (veterinários, ferradores, transportadores, etc.). Cada serviço possui título, descrição, benefício, imagem e contato WhatsApp. Visível apenas na área logada.

---

### 7. Galeria de Fotos
**Chave:** `galeria`
**Admin:** `admin_galeria.html`
**Coleção Firestore:** `cms_gallery`, `cms_gallery/{albumId}/fotos`
**Páginas públicas:** `gallery.html`

Álbuns de fotos de eventos e atividades do clube, organizados em galerias. O admin cria álbuns, faz upload de imagens (comprimidas automaticamente para ~200 KB) e define a ordem de exibição. Leitura pública; gravação restrita a admin/master.

---

### 8. Parcerias
**Chave:** `parcerias`
**Admin:** `admin_parceiros.html`
**Coleção Firestore:** `cms_partners`
**Páginas públicas:** `partners.html`

Vitrine de parceiros e patrocinadores do clube com logo, nome e link para o site. Exibe os parceiros também na seção de destaque da home (`index.html`). O admin gerencia o cadastro dos parceiros e a ordem de exibição. Leitura pública.

---

### 9. Diretoria
**Chave:** `diretoria`
**Admin:** `admin_diretoria.html`
**Coleção Firestore:** `cms_board`
**Páginas públicas:** `board.html`

Apresenta os membros da diretoria do clube: nome, cargo, foto e contato. Permite ao clube manter o organograma público atualizado sem necessidade de editar código HTML. O admin gerencia os membros e a ordem de exibição. Leitura pública.

---

### 10. Leilões
**Chave:** `leiloes`
**Admin:** `admin_leiloes.html`
**Coleção Firestore:** `auctionLots`, `auctionSales`, `auctionLots/{lotId}/bids`
**Páginas públicas:** `leiloes.html`, `leilao_lote.html`
**Páginas restritas:** `meus_lotes.html`, `lote_form.html`

Plataforma de leilões online para arrematação de cavalos, genética e equipamentos equestres. Associados autenticados podem cadastrar lotes com fotos, descrição e lance mínimo. Visitantes podem ver os lotes; lances e compras exigem login. O admin modera os lotes e acompanha as vendas. É o módulo mais complexo do sistema em termos de regras de negócio.

---

## Módulo de Conteúdo (CMS)

Não possui chave de módulo própria — é o conjunto de funcionalidades administrativas para gerenciar o conteúdo do site.

**Admin:** `admin_conteudo.html` (dashboard), `admin_banners.html`
**Coleção Firestore:** `cms_banners`, `cms_partners`

Gerencia o conteúdo dinâmico da home: banners do carrossel principal (com upload de imagem, link, título, subtítulo e ordem) e parceiros em destaque. Os banners são carregados do Firestore em tempo real, substituindo as imagens estáticas quando disponíveis. Imagens são armazenadas no Firebase Storage em `tenants/{orgId}/cms/{categoria}/`.

---

## Infraestrutura Compartilhada

| Componente | Descrição |
|-----------|-----------|
| `organizations/{orgId}` | Documento de configuração da organização: módulos ativos, plano, dados do clube |
| `systemLogs` | Auditoria de todas as ações administrativas (`logAction()` em `firebase.js`) |
| Firebase Auth | Autenticação por CPF → email interno (`cpf@cpf.local`) |
| Firebase Storage | Armazenamento de imagens com compressão automática (~200 KB) |
| Asaas | Processamento de pagamentos recorrentes (PIX, Boleto, Cartão) via webhook |
| Cloud Functions | Automações: relatório diário, integração Asaas, sincronização de dados |

---

## Controle de Acesso por Role

| Role | Permissões |
|------|-----------|
| `master` | Acesso total, incluindo configuração de organizações e módulos |
| `admin` | Acesso a todos os módulos administrativos da sua organização |
| `associado` | Acesso à área do associado: dashboard, produtos, serviços, classificados, pagamentos |
| Visitante | Acesso às páginas públicas dos módulos ativos (eventos, classificados, galeria, parcerias, diretoria, leilões) |
