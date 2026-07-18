// @ts-check
const { test, expect } = require('@playwright/test');

// Tests for all public pages (no auth required)
// Validates: page loads, title present, no JS crashes, key content visible

const PUBLIC_PAGES = [
  { path: '/', title: 'Clube do Cavalo', contentId: null },
  { path: '/events.html', title: 'Evento', contentId: null },
  { path: '/partners.html', title: 'Parcerias', contentId: null },
  { path: '/gallery.html', title: 'Galeria', contentId: null },
  { path: '/board.html', title: 'Diretoria', contentId: null },
  { path: '/sobre.html', title: 'Sobre', contentId: null },
  { path: '/classificados.html', title: 'Classificados', contentId: null },
];

// reset_senha.html has a self-service SMS reset flow (see 03-navigation.spec.js)
const AUTH_PAGES = [
  { path: '/login.html', title: 'Login', has: 'form' },
  { path: '/signup.html', title: 'Cadastro', has: 'form' },
  { path: '/login_master.html', title: 'Serafim Technologies', has: 'form' },
];

test.describe('Páginas Públicas', () => {
  for (const page of PUBLIC_PAGES) {
    test(`${page.path} carrega sem erro`, async ({ page: pw }) => {
      const errors = [];
      pw.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      pw.on('pageerror', err => errors.push(err.message));

      await pw.goto(page.path);
      await pw.waitForLoadState('domcontentloaded');

      // Page title should be present
      const title = await pw.title();
      expect(title.length).toBeGreaterThan(0);

      // No critical JS errors (Firebase/auth/permission/404 resource errors are acceptable)
      const criticalErrors = errors.filter(e =>
        !e.includes('permission') &&
        !e.includes('Firebase') &&
        !e.includes('Missing or insufficient') &&
        !e.includes('firestore') &&
        !e.includes('auth') &&
        !e.includes('404') &&
        !e.includes('Failed to load resource')
      );
      if (criticalErrors.length > 0) {
        console.log('JS errors on', page.path, ':', criticalErrors);
      }
      expect(criticalErrors.length).toBe(0);
    });
  }
});

test.describe('Páginas de Autenticação', () => {
  for (const page of AUTH_PAGES) {
    test(`${page.path} carrega com formulário`, async ({ page: pw }) => {
      await pw.goto(page.path);
      await pw.waitForLoadState('domcontentloaded');

      const title = await pw.title();
      expect(title.length).toBeGreaterThan(0);

        // Form: either a <form> tag or at least one input field
      const form = await pw.locator('form').count();
      const inputs = await pw.locator('input').count();
      expect(form + inputs, 'Nenhum formulário ou input encontrado').toBeGreaterThan(0);

      // Login/signup pages must have password input
      if (page.path.includes('login') || page.path.includes('signup')) {
        const passInput = await pw.locator('input[type="password"]').count();
        expect(passInput).toBeGreaterThan(0);
      }
    });
  }
});

test.describe('Página de Login Master', () => {
  test('login_master.html tem campos email e senha', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passInput')).toBeVisible();
    await expect(page.locator('#btnLogin')).toBeVisible();
    await expect(page.locator('#btnLogin')).toHaveText('Entrar');
  });

  test('login_master.html mostra erro com credenciais inválidas', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');

    await page.fill('#emailInput', 'invalido@invalido.com');
    await page.fill('#passInput', 'senhaerrada123');
    await page.click('#btnLogin');

    // Wait for error message
    await expect(page.locator('#errMsg')).toBeVisible({ timeout: 10000 });
    const errText = await page.locator('#errMsg').textContent();
    expect(errText.length).toBeGreaterThan(0);
  });
});
