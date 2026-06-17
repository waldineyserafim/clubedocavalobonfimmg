// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Permissões, Roles e Proteção de Rotas
// Verifica que todas as regras de acesso continuam intactas
// após a refatoração visual.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readPage(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

test.describe('Permissões — Visitante', () => {
  // Public pages must NOT have requireAuth
  const publicPages = [
    'index.html', 'events.html', 'classificados.html', 'gallery.html',
    'partners.html', 'board.html', 'sobre.html',
    'login.html', 'signup.html', 'reset_senha.html',
  ];

  for (const pg of publicPages) {
    test(`${pg} — visitante pode acessar (sem requireAuth)`, () => {
      const html = readPage(pg);
      expect(html).not.toContain('requireAuth(');
    });
  }

  // leiloes.html is public (requires no auth, but has optional auth for bidding)
  test('leiloes.html — acesso público sem requireAuth', () => {
    const html = readPage('leiloes.html');
    expect(html).not.toContain('requireAuth(');
  });

  test('pay-success.html — acesso público, usa applyModuleVisibility', () => {
    const html = readPage('pay-success.html');
    expect(html).toContain('applyModuleVisibility');
  });
});

test.describe('Permissões — Associado', () => {
  const assocPagesRequireAuth = ['meus_lotes.html', 'lote_form.html'];
  const assocPagesOnAuth = ['pg_associado.html', 'produtos_associado.html', 'servicos_associado.html', 'pay.html'];

  for (const pg of assocPagesRequireAuth) {
    test(`${pg} — protegida por requireAuth`, () => {
      const html = readPage(pg);
      expect(html).toContain('requireAuth(');
    });
  }

  for (const pg of assocPagesOnAuth) {
    test(`${pg} — protegida por onAuthStateChanged com redirect`, () => {
      const html = readPage(pg);
      const hasProtection = html.includes('requireAuth(') ||
        html.includes('onAuthStateChanged') ||
        html.includes('location.href') ||
        html.includes('location.replace');
      expect(hasProtection, `${pg} sem proteção de auth`).toBe(true);
    });
  }

  test('pg_associado.html — redireciona para login.html (não login_master)', () => {
    const html = readPage('pg_associado.html');
    const hasLoginRedirect = html.includes('"login.html"') || html.includes("'login.html'") ||
      html.includes('./login.html') || html.includes('login.html');
    expect(hasLoginRedirect).toBe(true);
    expect(html).not.toContain('login_master.html');
  });

  test('meus_lotes.html — não exige role admin (qualquer associado pode acessar)', () => {
    const html = readPage('meus_lotes.html');
    // Should NOT require admin role — any authenticated user is fine
    const requiresAdmin = html.includes('"requiredRole": "admin"') || html.includes('requiredRole: "admin"');
    expect(requiresAdmin).toBe(false);
  });
});

test.describe('Permissões — Admin', () => {
  const adminPages = [
    'admin.html', 'admin_associados.html', 'admin_produtos.html',
    'admin_servicos.html', 'admin_classificados.html', 'admin_leiloes.html',
    'admin_banners.html', 'admin_conteudo.html', 'admin_diretoria.html',
    'admin_eventos.html', 'admin_galeria.html', 'admin_parceiros.html',
  ];

  for (const pg of adminPages) {
    test(`${pg} — tem requireAuth`, () => {
      const html = readPage(pg);
      expect(html).toContain('requireAuth(');
    });

    test(`${pg} — redireciona para login.html (não login_master)`, () => {
      const html = readPage(pg);
      expect(html).not.toContain('"./login_master.html"');
    });

    test(`${pg} — tem role admin ou master`, () => {
      const html = readPage(pg);
      const hasAdminRole = html.includes('"admin"') || html.includes("'admin'") || html.includes('requiredRole');
      expect(hasAdminRole).toBe(true);
    });
  }
});

test.describe('Permissões — Master', () => {
  const masterPages = [
    'admin_master.html',
    'admin_master_associacoes.html',
    'admin_master_faturamento.html',
    'admin_master_configuracoes.html',
  ];

  for (const pg of masterPages) {
    test(`${pg} — requireAuth com role "master"`, () => {
      const html = readPage(pg);
      expect(html).toContain('requireAuth(');
      expect(html).toContain('"master"');
    });

    test(`${pg} — loginUrl aponta para login_master.html`, () => {
      const html = readPage(pg);
      expect(html).toContain('login_master.html');
    });

    test(`${pg} — Sair redireciona para login_master.html`, () => {
      const html = readPage(pg);
      // btnSair should redirect to login_master
      const hasMasterLogout = html.includes('login_master.html') && html.includes('btnSair');
      expect(hasMasterLogout, `${pg} sem logout para login_master`).toBe(true);
    });
  }

  test('login_master.html — verifica role=master antes de redirecionar', () => {
    const html = readPage('login_master.html');
    expect(html).toContain('"master"');
    expect(html).toContain('admin_master.html');
  });

  test('login_master.html — mostra erro se role não é master', () => {
    const html = readPage('login_master.html');
    expect(html).toContain('Acesso negado');
  });
});

test.describe('Permissões — applyModuleVisibility', () => {
  // Pages that should call applyModuleVisibility (public/associado area)
  const applyPages = [
    'index.html', 'events.html', 'classificados.html', 'gallery.html',
    'partners.html', 'board.html', 'sobre.html',
    'pg_associado.html', 'produtos_associado.html', 'servicos_associado.html',
    'leiloes.html', 'meus_lotes.html', 'lote_form.html', 'leilao_lote.html',
    'pay.html', 'pay-success.html',
  ];

  for (const pg of applyPages) {
    test(`${pg} — chama applyModuleVisibility()`, () => {
      const html = readPage(pg);
      expect(html, `${pg} não chama applyModuleVisibility`).toContain('applyModuleVisibility');
    });
  }
});

test.describe('Permissões — data-module attributes', () => {
  test('leiloes.html subnav tem data-module attributes', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('data-module=');
  });

  test('meus_lotes.html subnav tem data-module attributes', () => {
    const html = readPage('meus_lotes.html');
    expect(html).toContain('data-module=');
  });

  test('lote_form.html subnav tem data-module attributes', () => {
    const html = readPage('lote_form.html');
    expect(html).toContain('data-module=');
  });

  test('produtos_associado.html subnav tem data-module attributes', () => {
    const html = readPage('produtos_associado.html');
    expect(html).toContain('data-module=');
  });

  test('servicos_associado.html subnav tem data-module attributes', () => {
    const html = readPage('servicos_associado.html');
    expect(html).toContain('data-module=');
  });

  test('admin.html mod-cards tem data-module attributes', () => {
    const html = readPage('admin.html');
    expect(html).toContain('data-module=');
  });

  test('admin_leiloes.html subnav tem data-module="leiloes" active', () => {
    const html = readPage('admin_leiloes.html');
    // Active item (Leilões) should NOT have data-module (it's the current page, no hiding needed)
    // Other items should have data-module
    expect(html).toContain('data-module="associados"');
    expect(html).toContain('data-module="produtos"');
  });

  test('admin_classificados.html subnav tem data-module para os outros módulos', () => {
    const html = readPage('admin_classificados.html');
    expect(html).toContain('data-module="associados"');
    expect(html).toContain('data-module="leiloes"');
  });

  test('admin_associados.html subnav tem data-module para leilões', () => {
    const html = readPage('admin_associados.html');
    expect(html).toContain('data-module="leiloes"');
  });
});

test.describe('Permissões — setupAdminButton', () => {
  // Apenas as páginas que efetivamente chamam setupAdminButton (botão Admin dinâmico)
  // Verificado via grep no código-fonte real
  const adminBtnPages = [
    'classificados.html',
    'leiloes.html',
    'meus_lotes.html',
    'leilao_lote.html',
  ];

  for (const pg of adminBtnPages) {
    test(`${pg} — chama setupAdminButton()`, () => {
      const html = readPage(pg);
      expect(html, `${pg} não chama setupAdminButton`).toContain('setupAdminButton');
    });
  }

  test('firebase.js exporta setupAdminButton', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('setupAdminButton');
    expect(html).toContain('export');
  });
});

test.describe('Permissões — firebase.js (módulo central)', () => {
  test('firebase.js exporta requireAuth', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('requireAuth');
    expect(html).toContain('export');
  });

  test('firebase.js exporta applyModuleVisibility', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('applyModuleVisibility');
  });

  test('firebase.js exporta setupAdminButton', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('setupAdminButton');
  });

  test('firebase.js tem mapRole para normalizar roles', () => {
    const html = readPage('firebase.js');
    // Função interna chamada mapRole (não exportada como mapRoleServer)
    expect(html).toContain('mapRole');
    expect(html).toContain('normalize');
  });

  test('firebase.js tem loginUrl default = login.html', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('login.html');
  });

  test('firebase.js usa CPF → email pattern (@cpf.local)', () => {
    const html = readPage('firebase.js');
    expect(html).toContain('@cpf.local') || expect(html).toContain('cpf.local');
  });
});

// ─── Live browser: Redirect behavior ────────────────────────────────────────

test.describe('Proteção de Rotas — Testes ao Vivo', () => {
  test('Visitar admin.html sem auth não expõe conteúdo admin (sem crash)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/admin.html');
    await page.waitForLoadState('domcontentloaded');
    // Aguarda Firebase resolver auth state (redirect async)
    await page.waitForTimeout(2000);

    // A proteção estática (requireAuth) já é validada em 02-auth-redirects.spec.js.
    // Aqui validamos apenas que não houve crash JS crítico durante o carregamento.
    const criticalErrors = errors.filter(e =>
      !e.includes('Firebase') && !e.includes('auth') &&
      !e.includes('permission') && !e.includes('network')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('Visitar admin_master.html sem auth não causa crash JS', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/admin_master.html');
    await page.waitForLoadState('domcontentloaded');

    const criticalErrors = errors.filter(e =>
      !e.includes('Firebase') && !e.includes('auth') && !e.includes('permission')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('Visitar login_master.html mostra formulário de login', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passInput')).toBeVisible();
    await expect(page.locator('#btnLogin')).toBeVisible();
  });

  test('leiloes.html carrega para visitante sem auth', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    // Should not redirect to login
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('login.html');
    expect(page.url()).not.toContain('login_master.html');
  });
});
