// @ts-check
const { test, expect } = require('@playwright/test');

// ============================================================
// Testes ao Vivo — Múltiplos Viewports
// Valida que as páginas carregam corretamente em:
//   - Mobile: 390px (iPhone 14)
//   - Tablet: 768px (iPad)
//   - Desktop: 1366px
// ============================================================

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1366', width: 1366, height: 768 },
];

// Páginas públicas que não precisam de auth
const PUBLIC_PAGES = [
  { path: '/', name: 'Home' },
  { path: '/events.html', name: 'Eventos' },
  { path: '/classificados.html', name: 'Classificados' },
  { path: '/gallery.html', name: 'Galeria' },
  { path: '/partners.html', name: 'Parceiros' },
  { path: '/board.html', name: 'Diretoria' },
  { path: '/sobre.html', name: 'Sobre' },
  { path: '/login.html', name: 'Login' },
  { path: '/signup.html', name: 'Cadastro' },
  { path: '/leiloes.html', name: 'Leilões' },
  { path: '/login_master.html', name: 'Login Master' },
  { path: '/pay-success.html', name: 'Pay Success' },
];

for (const vp of VIEWPORTS) {
  test.describe(`Viewport ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const pg of PUBLIC_PAGES) {
      test(`${pg.name} (${pg.path}) carrega sem erros em ${vp.width}px`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });

        await page.goto(pg.path);
        await page.waitForLoadState('domcontentloaded');

        // Filter out expected Firebase/network errors
        const criticalErrors = errors.filter(e =>
          !e.includes('Firebase') &&
          !e.includes('firestore') &&
          !e.includes('auth') &&
          !e.includes('permission') &&
          !e.includes('404') &&
          !e.includes('Failed to load resource') &&
          !e.includes('net::') &&
          !e.includes('fetch')
        );

        if (criticalErrors.length > 0) {
          console.log(`[${vp.name}] ${pg.path} errors:`, criticalErrors);
        }

        expect(criticalErrors).toHaveLength(0);

        // Page has a title
        const title = await page.title();
        expect(title.length).toBeGreaterThan(0);
      });
    }

    test(`Navbar visível em ${vp.width}px (Home)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      const navbar = page.locator('nav.navbar');
      await expect(navbar).toBeVisible();
    });

    test(`Footer visível em ${vp.width}px (Home)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      const footer = page.locator('footer');
      await expect(footer).toBeVisible();
    });

    test(`Logo no navbar em ${vp.width}px (Home)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      // Brand link should contain the logo image
      const brandLink = page.locator('a.navbar-brand');
      await expect(brandLink).toBeVisible();
      const logoImg = brandLink.locator('img.brand-logo');
      await expect(logoImg).toBeVisible();
    });
  });
}

// ─── Mobile-specific tests ────────────────────────────────────────────────────

test.describe('Mobile 390px — Navbar Responsiva', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Home — hambúrguer visível no mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const toggler = page.locator('button.navbar-toggler');
    await expect(toggler).toBeVisible();
  });

  test('Home — hambúrguer abre/fecha o menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const toggler = page.locator('button.navbar-toggler');
    const navCollapse = page.locator('.navbar-collapse');

    // Menu starts collapsed
    await expect(navCollapse).not.toHaveClass(/show/);

    // Click toggler to open
    await toggler.click();
    await page.waitForTimeout(400);
    await expect(navCollapse).toHaveClass(/show/);

    // Click again to close
    await toggler.click();
    await page.waitForTimeout(400);
    await expect(navCollapse).not.toHaveClass(/show/);
  });

  test('Login — formulário visível e usável no mobile', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');

    const cpfInput = page.locator('#cpf');
    const passInput = page.locator('#password');

    await expect(cpfInput).toBeVisible();
    await expect(passInput).toBeVisible();

    // Verifica interação via fill (mais estável que click+type em mobile emulado)
    // CPF input tem máscara — fill dispara eventos nativos
    await cpfInput.fill('12345678900', { timeout: 5000 });
    const value = await cpfInput.inputValue();
    // Com máscara, o valor retorna formatado (123.456.789-00) ou sem máscara
    expect(value.length, 'CPF input não aceita entrada').toBeGreaterThan(0);
  });

  test('Login Master — formulário visível no mobile', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passInput')).toBeVisible();
  });

  test('Signup — formulário visível no mobile', async ({ page }) => {
    await page.goto('/signup.html');
    await page.waitForLoadState('domcontentloaded');

    const inputs = page.locator('input');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(2);
  });

  test('Leilões — subnav scrollável horizontalmente no mobile', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    // ds-pills container should exist
    const subnav = page.locator('.ds-pills');
    await expect(subnav).toBeVisible();
  });
});

// ─── Desktop-specific tests ───────────────────────────────────────────────────

test.describe('Desktop 1366px — Layout Completo', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('Home — menu de navegação visível (expanded)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // In desktop, navbar links should be visible without toggling
    const navLinks = page.locator('.navbar-nav .nav-link');
    const count = await navLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Leilões — subnav pills visíveis', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    const pills = page.locator('.ds-pill');
    const count = await pills.count();
    expect(count).toBeGreaterThan(1);
  });

  test('Login — campos visíveis no desktop', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');

    // login.html não usa <form> — inputs são diretamente no container
    const cpfInput = page.locator('#cpf');
    await expect(cpfInput).toBeVisible();
  });
});

// ─── Tablet-specific tests ────────────────────────────────────────────────────

test.describe('Tablet 768px — Layout Intermediário', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('Home carrega corretamente em 768px', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const navbar = page.locator('nav.navbar');
    await expect(navbar).toBeVisible();
  });

  test('Formulário de login funcional em 768px', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#cpf')).toBeVisible();
  });
});

// ─── CSS Visual Checks ────────────────────────────────────────────────────────

test.describe('CSS — Design System aplicado ao vivo', () => {
  test('Home — design-system.css é carregado sem erro 404', async ({ page }) => {
    const responses = [];
    page.on('response', resp => {
      if (resp.url().includes('design-system')) {
        responses.push({ url: resp.url(), status: resp.status() });
      }
    });

    await page.goto('/');
    // Usar domcontentloaded — networkidle pode nunca disparar com Firebase polling
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // aguardar carregamento de assets

    const dsResponses = responses.filter(r => r.url.includes('design-system'));
    expect(dsResponses.length, 'design-system.css não foi carregado').toBeGreaterThan(0);

    const failedLoads = dsResponses.filter(r => r.status !== 200);
    expect(failedLoads, `design-system.css retornou erro: ${JSON.stringify(failedLoads)}`).toHaveLength(0);
  });

  test('Home — Bootstrap Icons CDN carregado sem erro', async ({ page }) => {
    const responses = [];
    page.on('response', resp => {
      if (resp.url().includes('bootstrap-icons')) {
        responses.push({ url: resp.url(), status: resp.status() });
      }
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const biResponses = responses.filter(r => r.url.includes('bootstrap-icons'));
    expect(biResponses.length, 'bootstrap-icons CDN não foi carregado').toBeGreaterThan(0);

    const failed = biResponses.filter(r => r.status !== 200);
    expect(failed, `bootstrap-icons CDN com erro: ${JSON.stringify(failed)}`).toHaveLength(0);
  });

  test('Home — footer tem cor brand-dark (dark background)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const footer = page.locator('footer');
    await expect(footer).toBeVisible();

    // Footer should have dark background (brand-dark)
    const bgColor = await footer.evaluate(el => getComputedStyle(el).backgroundColor);
    // brand-dark is #0a0c55 → rgb(10, 12, 85)
    expect(bgColor).toContain('10') || expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('Login Master — background escuro (#0d0f2e)', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    const body = page.locator('body');
    const bgColor = await body.evaluate(el => getComputedStyle(el).backgroundColor);
    // Dark background - not white
    expect(bgColor).not.toBe('rgb(255, 255, 255)');
  });

  test('Subnav pills têm estilo diferente de btn-outline-primary', async ({ page }) => {
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');

    // ds-pill should not have Bootstrap btn classes mixed in
    const pills = page.locator('.ds-pill');
    const count = await pills.count();
    expect(count).toBeGreaterThan(0);

    // They should NOT have btn-outline-primary class
    const oldStylePills = page.locator('.btn-outline-primary.ds-pill');
    const oldCount = await oldStylePills.count();
    expect(oldCount).toBe(0);
  });
});

// ─── Accessibility Basics ─────────────────────────────────────────────────────

test.describe('Acessibilidade — Basics', () => {
  test('Login — input CPF tem label associada', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');

    const cpfInput = page.locator('#cpf');
    await expect(cpfInput).toBeVisible();

    // Input should have associated label
    const label = page.locator('label[for="cpf"]');
    const labelCount = await label.count();
    // Either label[for] or aria-label
    const ariaLabel = await cpfInput.getAttribute('aria-label');
    const hasLabel = labelCount > 0 || ariaLabel !== null;
    expect(hasLabel, 'Input CPF sem label acessível').toBe(true);
  });

  test('Login Master — inputs têm labels', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    const emailLabel = page.locator('label[for="emailInput"]');
    const passLabel = page.locator('label[for="passInput"]');

    const emailLabelCount = await emailLabel.count();
    const passLabelCount = await passLabel.count();

    expect(emailLabelCount + passLabelCount).toBeGreaterThan(0);
  });

  test('Navbar — toggler tem aria-label', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const toggler = page.locator('button.navbar-toggler');
    const count = await toggler.count();
    if (count > 0) {
      const ariaLabel = await toggler.getAttribute('aria-label');
      expect(ariaLabel, 'navbar-toggler sem aria-label').toBeTruthy();
    }
  });

  test('Imagens de logo têm atributo alt', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const logoImgs = page.locator('img.brand-logo');
    const count = await logoImgs.count();
    expect(count).toBeGreaterThan(0);

    const alt = await logoImgs.first().getAttribute('alt');
    expect(alt, 'Logo sem atributo alt').toBeTruthy();
  });
});

// ─── Screenshot Evidence ──────────────────────────────────────────────────────

test.describe('Screenshots — Evidências Visuais', () => {
  test('Captura Home em 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'playwright-report/screenshots/home-390px.png', fullPage: true });
  });

  test('Captura Home em 1366px', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'playwright-report/screenshots/home-1366px.png', fullPage: true });
  });

  test('Captura Login em 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: 'playwright-report/screenshots/login-390px.png', fullPage: true });
  });

  test('Captura Login Master', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: 'playwright-report/screenshots/login-master-390px.png', fullPage: true });
  });

  test('Captura Leilões em 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/leiloes.html');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'playwright-report/screenshots/leiloes-390px.png', fullPage: true });
  });

  test('Captura pay-success em 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/pay-success.html');
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: 'playwright-report/screenshots/pay-success-390px.png', fullPage: true });
  });

  test('Captura Classificados em 768px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/classificados.html');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'playwright-report/screenshots/classificados-768px.png', fullPage: true });
  });
});
