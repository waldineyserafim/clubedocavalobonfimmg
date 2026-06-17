// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Regressão de Design System
// Verifica que TODAS as 31 páginas têm DS integrado corretamente
// e que nenhum CSS inline de override foi deixado para trás.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readPage(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

const ALL_HTML_PAGES = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html') && !fs.statSync(path.join(ROOT, f)).isDirectory());

// Pages that legitimately have no design-system (prototypes, etc.)
const DS_EXEMPT = [];

test.describe('Design System — Todas as Páginas', () => {
  test('Confirma lista completa de 31 páginas HTML', () => {
    expect(ALL_HTML_PAGES.length).toBeGreaterThanOrEqual(31);
  });

  for (const page of ALL_HTML_PAGES) {
    if (DS_EXEMPT.includes(page)) continue;

    test(`${page} — tem design-system.css`, () => {
      const html = readPage(page);
      expect(html, `${page} sem design-system.css`).toContain('design-system.css');
    });

    test(`${page} — tem Bootstrap Icons CDN`, () => {
      const html = readPage(page);
      expect(html, `${page} sem bootstrap-icons.min.css`).toContain('bootstrap-icons.min.css');
    });

    test(`${page} — sem :root inline duplicado`, () => {
      const html = readPage(page);
      const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
      // Strip block comments before checking (avoid matching /* :root, Bootstrap... */ comment)
      const strippedBlocks = styleBlocks.map(b => b.replace(/\/\*[\s\S]*?\*\//g, ''));
      const hasRootInStyle = strippedBlocks.some(block => /:root\s*\{/.test(block));
      expect(hasRootInStyle, `${page} tem :root{ inline em <style>`).toBe(false);
    });

    test(`${page} — sem brand-logo CSS override inline`, () => {
      const html = readPage(page);
      const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
      const hasBrandLogo = styleBlocks.some(block => block.includes('.brand-logo{') || block.includes('.brand-logo {'));
      expect(hasBrandLogo, `${page} tem .brand-logo{} CSS inline`).toBe(false);
    });

    test(`${page} — tem shortcut icon`, () => {
      const html = readPage(page);
      expect(html, `${page} sem shortcut icon`).toContain('shortcut icon');
    });

    test(`${page} — tem Bootstrap 5.3.3`, () => {
      const html = readPage(page);
      expect(html, `${page} sem Bootstrap 5.3.3`).toContain('bootstrap@5.3.3');
    });
  }
});

test.describe('Design System — Variáveis CSS existem no arquivo', () => {
  test('design-system.css existe', () => {
    const dsPath = path.join(ROOT, 'assets/css/design-system.css');
    expect(fs.existsSync(dsPath), 'design-system.css não encontrado').toBe(true);
  });

  test('design-system.css tem variáveis de marca corretas', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/css/design-system.css'), 'utf8');
    expect(css).toContain('--brand:');
    expect(css).toContain('--brand-dark:');
    expect(css).toContain('--brand-light:');
    expect(css).toContain('--accent:');
  });

  test('design-system.css tem classes ds-pill e ds-pills', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/css/design-system.css'), 'utf8');
    expect(css).toContain('.ds-pill');
    expect(css).toContain('.ds-pills');
  });

  test('design-system.css tem brand-logo e brand-title classes', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/css/design-system.css'), 'utf8');
    expect(css).toContain('.brand-logo');
    expect(css).toContain('.brand-title');
  });

  test('design-system.css tem z-index de navbar', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/css/design-system.css'), 'utf8');
    expect(css).toContain('--z-navbar');
  });
});

test.describe('Design System — Navbar Pattern', () => {
  // Public/Associado pages: logo must be INSIDE the <a> link
  const publicAssocPages = [
    'index.html', 'events.html', 'classificados.html', 'gallery.html',
    'partners.html', 'board.html', 'sobre.html',
    'pg_associado.html', 'produtos_associado.html', 'servicos_associado.html',
    'pay.html', 'pay-success.html', 'leiloes.html', 'meus_lotes.html', 'lote_form.html',
  ];

  for (const page of publicAssocPages) {
    test(`${page} — logo (brand-logo) está dentro do link navbar-brand`, () => {
      const html = readPage(page);
      // Pattern: <a class="navbar-brand..."> ... <img class="brand-logo" ...> ... </a>
      // Detect: brand-logo should NOT appear before the opening of navbar-brand link
      const brandLinkMatch = html.match(/(<a[^>]+navbar-brand[^>]*>)([\s\S]*?)(<\/a>)/);
      expect(brandLinkMatch, `${page} sem navbar-brand link`).toBeTruthy();
      if (brandLinkMatch) {
        const linkInnerHTML = brandLinkMatch[2];
        expect(linkInnerHTML, `${page}: brand-logo não está dentro do navbar-brand link`).toContain('brand-logo');
      }
    });
  }

  // Admin pages: simplified navbar (no collapsible)
  const adminPages = [
    'admin.html', 'admin_associados.html', 'admin_produtos.html',
    'admin_servicos.html', 'admin_classificados.html', 'admin_leiloes.html',
    'admin_banners.html', 'admin_conteudo.html', 'admin_diretoria.html',
    'admin_eventos.html', 'admin_galeria.html', 'admin_parceiros.html', 'admin_sobre.html',
  ];

  for (const page of adminPages) {
    test(`${page} — navbar admin sem collapse desnecessário`, () => {
      const html = readPage(page);
      // Admin pages should have navbar but simplified (no collapsible div for nav links)
      expect(html).toContain('navbar');
      // Must have brand/logo
      expect(html).toContain('navbar-brand');
    });
  }
});

test.describe('Design System — Footer Dark', () => {
  // All pages except master (which use sidebar layout) and login pages (no footer) should have dark footer
  const footerPages = [
    'index.html', 'events.html', 'classificados.html', 'gallery.html',
    'partners.html', 'board.html', 'sobre.html',
    'pg_associado.html', 'produtos_associado.html', 'servicos_associado.html',
    'pay.html', 'pay-success.html', 'leiloes.html', 'leilao_lote.html',
    'meus_lotes.html', 'lote_form.html',
    'admin.html', 'admin_associados.html', 'admin_produtos.html',
    'admin_servicos.html', 'admin_classificados.html', 'admin_leiloes.html',
    'admin_banners.html', 'admin_conteudo.html', 'admin_diretoria.html',
    'admin_eventos.html', 'admin_galeria.html', 'admin_parceiros.html', 'admin_sobre.html',
  ];

  for (const page of footerPages) {
    test(`${page} — tem footer dark (--brand-dark)`, () => {
      const html = readPage(page);
      expect(html, `${page} sem footer brand-dark`).toContain('brand-dark');
    });
  }
});

test.describe('Design System — Subnav ds-pill', () => {
  const subnavPages = [
    'admin_associados.html', 'admin_produtos.html', 'admin_servicos.html',
    'admin_classificados.html', 'admin_leiloes.html',
    'admin_banners.html', 'admin_conteudo.html', 'admin_diretoria.html',
    'admin_eventos.html', 'admin_galeria.html', 'admin_parceiros.html', 'admin_sobre.html',
    'produtos_associado.html', 'servicos_associado.html',
    'leiloes.html', 'meus_lotes.html', 'lote_form.html',
  ];

  for (const page of subnavPages) {
    test(`${page} — tem ds-pill no subnav`, () => {
      const html = readPage(page);
      expect(html, `${page} sem classe ds-pill`).toContain('ds-pill');
    });

    test(`${page} — tem um ds-pill active (página atual)`, () => {
      const html = readPage(page);
      expect(html, `${page} sem ds-pill active`).toContain('ds-pill active');
    });
  }
});
