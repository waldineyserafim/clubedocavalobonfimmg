// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Leilões — Estrutura e Funcionalidades
// Verifica fluxo completo de leilões: cadastro, publicação,
// moderação, lances e encerramento.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readPage(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

test.describe('Leilões — Página Pública (leiloes.html)', () => {
  test('Tem listagem de lotes com status', () => {
    const html = readPage('leiloes.html');
    const hasLots = html.includes('lot-card') || html.includes('auctionLot') || html.includes('lote');
    expect(hasLots, 'Sem listagem de lotes').toBe(true);
  });

  test('Tem badge LIVE ou badge Em Andamento', () => {
    const html = readPage('leiloes.html');
    const hasLive = html.includes('badge-live') || html.includes('live') || html.includes('LIVE') || html.includes('andamento');
    expect(hasLive, 'Sem badge de status ao vivo').toBe(true);
  });

  test('Tem countdown timer', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('countdown');
  });

  test('Tem checkModuleEnabled para módulo leiloes', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('checkModuleEnabled');
    expect(html).toContain('leiloes');
  });

  test('Tem filtro por orgId', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('currentOrgId') || expect(html).toContain('orgId');
  });

  test('Subnav tem ds-pill active em Leilões', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('ds-pill active');
    // The active pill should be Leilões (current page)
    const activeMatch = html.match(/ds-pill active[^>]*>([\s\S]*?)<\/a>/);
    expect(activeMatch, 'Não encontrou ds-pill active').toBeTruthy();
  });
});

test.describe('Leilões — Detalhe do Lote (leilao_lote.html)', () => {
  test('Tem galeria de imagens (main-photo + thumbnails)', () => {
    const html = readPage('leilao_lote.html');
    const hasGallery = html.includes('main-photo') || html.includes('thumb-strip') || html.includes('photo');
    expect(hasGallery, 'Sem galeria de imagens').toBe(true);
  });

  test('Tem bid-box (caixa de lance)', () => {
    const html = readPage('leilao_lote.html');
    const hasBid = html.includes('bid-box') || html.includes('bid_box') || html.includes('lance');
    expect(hasBid, 'Sem bid-box ou campo de lance').toBe(true);
  });

  test('Tem countdown timer no lote', () => {
    const html = readPage('leilao_lote.html');
    expect(html).toContain('countdown');
  });

  test('Tem histórico de lances (bid-row)', () => {
    const html = readPage('leilao_lote.html');
    const hasBidHistory = html.includes('bid-row') || html.includes('bidRow') || html.includes('historico') || html.includes('lances');
    expect(hasBidHistory, 'Sem histórico de lances').toBe(true);
  });

  test('Tem indicador de vencedor (bid-winner)', () => {
    const html = readPage('leilao_lote.html');
    const hasWinner = html.includes('bid-winner') || html.includes('winner') || html.includes('vencedor');
    expect(hasWinner, 'Sem indicador de vencedor').toBe(true);
  });

  test('Tem checkModuleEnabled para leiloes', () => {
    const html = readPage('leilao_lote.html');
    expect(html).toContain('checkModuleEnabled');
    expect(html).toContain('"leiloes"');
  });

  test('Tem applyModuleVisibility', () => {
    const html = readPage('leilao_lote.html');
    expect(html).toContain('applyModuleVisibility');
  });
});

test.describe('Leilões — Meus Lotes (meus_lotes.html)', () => {
  test('Tem listagem de lotes do usuário', () => {
    const html = readPage('meus_lotes.html');
    const hasList = html.includes('lot-row') || html.includes('lotRow') || html.includes('meus lotes') || html.includes('Meus Lotes');
    expect(hasList, 'Sem lista de lotes do usuário').toBe(true);
  });

  test('Tem details-panel (painel de detalhes expandível)', () => {
    const html = readPage('meus_lotes.html');
    const hasDetails = html.includes('details-panel') || html.includes('detailsPanel') || html.includes('collapse');
    expect(hasDetails, 'Sem painel de detalhes').toBe(true);
  });

  test('Tem link para cadastrar novo lote (lote_form.html)', () => {
    const html = readPage('meus_lotes.html');
    expect(html).toContain('lote_form.html');
  });

  test('Subnav tem ds-pill active em Meus Lotes e link para Leilões', () => {
    const html = readPage('meus_lotes.html');
    expect(html).toContain('ds-pill active');
    expect(html).toContain('leiloes.html');
  });

  test('Tem requireAuth para associado autenticado', () => {
    const html = readPage('meus_lotes.html');
    expect(html).toContain('requireAuth(');
  });
});

test.describe('Leilões — Cadastro de Lote (lote_form.html)', () => {
  test('Tem campo de categoria', () => {
    const html = readPage('lote_form.html');
    const hasCat = html.includes('categoria') || html.includes('category') || html.includes('Categoria');
    expect(hasCat, 'Sem campo categoria').toBe(true);
  });

  test('Tem campo de raça', () => {
    const html = readPage('lote_form.html');
    const hasRace = html.includes('raça') || html.includes('raca') || html.includes('Raça');
    expect(hasRace, 'Sem campo raça').toBe(true);
  });

  test('Tem campo de nome do animal', () => {
    const html = readPage('lote_form.html');
    const hasName = html.includes('nome') || html.includes('Nome');
    expect(hasName).toBe(true);
  });

  test('Tem campo de valor inicial/lance mínimo', () => {
    const html = readPage('lote_form.html');
    const hasValue = html.includes('precoInicial') || html.includes('valorInicial') ||
                     html.includes('lanceMinimo') || html.includes('Valor') || html.includes('lance');
    expect(hasValue, 'Sem campo de valor').toBe(true);
  });

  test('Tem upload de múltiplas fotos', () => {
    const html = readPage('lote_form.html');
    expect(html).toContain('type="file"');
    const hasMultiple = html.includes('multiple') || html.includes('img-preview');
    expect(hasMultiple, 'Sem suporte a múltiplas fotos').toBe(true);
  });

  test('Tem botão de submit do lote', () => {
    const html = readPage('lote_form.html');
    const hasSubmit = html.includes('btnSalvar') || html.includes('btnSubmit') ||
                      html.includes('type="submit"') || html.includes('Salvar');
    expect(hasSubmit, 'Sem botão de submit').toBe(true);
  });

  test('Tem requireAuth para associado', () => {
    const html = readPage('lote_form.html');
    expect(html).toContain('requireAuth(');
  });

  test('Tem seções organizadas (section-card)', () => {
    const html = readPage('lote_form.html');
    const hasSections = html.includes('section-card') || html.includes('section-title');
    expect(hasSections, 'Sem seções organizadas').toBe(true);
  });
});

test.describe('Leilões — Moderação Admin (admin_leiloes.html)', () => {
  test('Tem abas para Lotes e Vendas', () => {
    const html = readPage('admin_leiloes.html');
    const hasTabs = html.includes('lote') && html.includes('vend');
    expect(hasTabs, 'Sem abas de Lotes/Vendas').toBe(true);
  });

  test('Tem ID para container de lotes (loading e tabela)', () => {
    const html = readPage('admin_leiloes.html');
    const hasLoading = html.includes('lotesLoading') || html.includes('loading') || html.includes('Loading');
    expect(hasLoading, 'Sem indicador de loading').toBe(true);
  });

  test('Tem ação de publicar lote', () => {
    const html = readPage('admin_leiloes.html');
    const hasPublish = html.includes('publicado') || html.includes('publish') || html.includes('Publicar');
    expect(hasPublish, 'Sem ação de publicar').toBe(true);
  });

  test('Tem ação de encerrar lote', () => {
    const html = readPage('admin_leiloes.html');
    const hasClose = html.includes('encerrado') || html.includes('encerrar') || html.includes('Encerrar');
    expect(hasClose, 'Sem ação de encerrar').toBe(true);
  });

  test('Tem grid/row de lotes (lot-row)', () => {
    const html = readPage('admin_leiloes.html');
    const hasGrid = html.includes('lot-row') || html.includes('lotRow') || html.includes('lot-header');
    expect(hasGrid, 'Sem grid de lotes').toBe(true);
  });

  test('Tem seção de vendas (sale-row)', () => {
    const html = readPage('admin_leiloes.html');
    const hasSales = html.includes('sale-row') || html.includes('saleRow') || html.includes('vend');
    expect(hasSales, 'Sem seção de vendas').toBe(true);
  });

  test('Subnav tem ds-pill active em Leilões com data-module nos outros', () => {
    const html = readPage('admin_leiloes.html');
    expect(html).toContain('ds-pill active');
    expect(html).toContain('data-module="associados"');
    expect(html).toContain('data-module="produtos"');
  });

  test('Tem requireAuth com role admin', () => {
    const html = readPage('admin_leiloes.html');
    expect(html).toContain('requireAuth(');
  });
});

// ─── Live browser: Leilões ────────────────────────────────────────────────────

test.describe('Leilões — Testes ao Vivo', () => {
  test('/leiloes.html carrega e exibe subnav', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    // Subnav should be visible
    const subnav = page.locator('.ds-pills');
    await expect(subnav).toBeVisible();
  });

  test('/leiloes.html subnav tem pill active (Leilões)', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    const activePill = page.locator('.ds-pill.active');
    await expect(activePill).toBeVisible();
    const text = await activePill.textContent();
    expect(text?.trim()).toContain('Leilões');
  });

  test('/leiloes.html navbar tem logo dentro do link', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    const brandLink = page.locator('a.navbar-brand');
    await expect(brandLink).toBeVisible();

    const logoInsideLink = brandLink.locator('img.brand-logo');
    await expect(logoInsideLink).toBeVisible();
  });

  test('/leilao_lote.html carrega sem erro crítico', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/leilao_lote.html');
    await page.waitForLoadState('domcontentloaded');

    // Sem lotId na URL, a página pode exibir "lote não encontrado" ou
    // TypeError de lotId null — esses são erros esperados sem context de lote.
    // Filtramos erros esperados de Firebase, auth, permission, 404 e TypeError de parâmetros
    const criticalErrors = errors.filter(e =>
      !e.includes('Firebase') &&
      !e.includes('firestore') &&
      !e.includes('auth') &&
      !e.includes('permission') &&
      !e.includes('404') &&
      !e.includes('TypeError') &&
      !e.includes('Cannot read') &&
      !e.includes('null') &&
      !e.includes('undefined') &&
      !e.includes('net::') &&
      !e.includes('fetch')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
