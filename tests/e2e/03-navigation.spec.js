// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
function readPage(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// ============================================================
// Navigation & Structure — mostly static checks to avoid CDN latency
// ============================================================

test.describe('Links Internos — Verificação Estática', () => {
  test('index.html referencia páginas que existem', () => {
    const html = readPage('index.html');
    const knownPages = ['login.html','classificados.html','leiloes.html','events.html',
                        'partners.html','gallery.html','board.html','sobre.html'];
    for (const p of knownPages) {
      if (html.includes(p)) {
        expect(fs.existsSync(path.join(ROOT, p))).toBeTruthy();
      }
    }
  });

  test('Nenhuma página HTML referencia arquivo que não existe', () => {
    const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
    const broken = [];
    for (const file of htmlFiles) {
      const html = readPage(file);
      const links = [...html.matchAll(/href="([^"#?]*\.html)/g)].map(m => m[1]);
      for (const link of links) {
        if (link.startsWith('http') || link.startsWith('//')) continue;
        if (!fs.existsSync(path.join(ROOT, link))) {
          broken.push(`${file} → ${link}`);
        }
      }
    }
    expect(broken.length, `Links quebrados: ${broken.join(', ')}`).toBe(0);
  });
});

test.describe('Estrutura HTML — Verificação Estática', () => {
  test('login.html tem input CPF e senha', () => {
    const html = readPage('login.html');
    expect(html).toContain('id="cpf"');
    expect(html).toContain('type="password"');
  });

  test('signup.html tem inputs de cadastro', () => {
    const html = readPage('signup.html');
    expect(html).toContain('type="password"');
    expect(html).toContain('cpf');
  });

  test('login_master.html tem input email e senha', () => {
    const html = readPage('login_master.html');
    expect(html).toContain('id="emailInput"');
    expect(html).toContain('id="passInput"');
  });

  test('admin_master.html tem os 4 itens do menu', () => {
    const html = readPage('admin_master.html');
    expect(html).toContain('admin_master.html');
    expect(html).toContain('admin_master_associacoes.html');
    expect(html).toContain('admin_master_faturamento.html');
    expect(html).toContain('admin_master_configuracoes.html');
  });

  test('admin_master.html referencia login_master.html para redirect', () => {
    const html = readPage('admin_master.html');
    expect(html).toContain('login_master.html');
  });

  test('pay-success.html tem conteúdo de confirmação de pagamento', () => {
    const html = readPage('pay-success.html');
    expect(html.length).toBeGreaterThan(200);
    // Has some success/payment related content
    const hasContent = html.toLowerCase().includes('pagamento') ||
                       html.toLowerCase().includes('sucesso') ||
                       html.toLowerCase().includes('confirmação');
    expect(hasContent).toBeTruthy();
  });

  test('reset_senha.html é página estática sem formulário (by design)', () => {
    const html = readPage('reset_senha.html');
    // Should have WhatsApp link and not have password input
    expect(html).toContain('wa.me');
    expect(html).not.toContain('type="password"');
  });
});

test.describe('Classificados — Verificação de Código', () => {
  test('classificados.html tem filtro orgId na query', () => {
    const html = readPage('classificados.html');
    expect(html).toContain('currentOrgId');
    expect(html).toContain("where('orgId'");
  });

  test('classificados.html não tem referência a PERMISSION_DENIED esperada', () => {
    const html = readPage('classificados.html');
    // Should use public queries that don't require auth
    expect(html).toContain("where('active'");
    expect(html).toContain("where('approved'");
  });
});

test.describe('Leilões — Verificação de Código', () => {
  test('leiloes.html tem filtro orgId e checkModuleEnabled', () => {
    const html = readPage('leiloes.html');
    expect(html).toContain('currentOrgId');
    expect(html).toContain('checkModuleEnabled');
  });

  test('leilao_lote.html tem checkModuleEnabled para leiloes', () => {
    const html = readPage('leilao_lote.html');
    expect(html).toContain('checkModuleEnabled');
    expect(html).toContain('"leiloes"');
  });
});

test.describe('Páginas ao vivo — Carregamento Básico', () => {
  test('/login_master.html carrega e tem formulário', async ({ page }) => {
    await page.goto('/login_master.html');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passInput')).toBeVisible();
  });

  test('/login.html carrega e tem campo CPF', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#cpf')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});
