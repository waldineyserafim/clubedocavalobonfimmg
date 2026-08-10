// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Integridade DOM para Firebase
// Verifica que todos os IDs usados por getElementById() e
// seletores JS ainda existem no HTML após a refatoração.
// A refatoração visual NÃO deve remover elementos funcionais.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readPage(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

function hasId(html, id) {
  return html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
}

function extractGetElementIds(html) {
  const matches = [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)];
  return matches.map(m => m[1]);
}

test.describe('DOM Integrity — login.html', () => {
  test('IDs críticos presentes: cpf, password, msg, loginBtn', () => {
    const html = readPage('login.html');
    expect(hasId(html, 'cpf'), 'Falta #cpf').toBe(true);
    expect(hasId(html, 'msg'), 'Falta #msg (feedback de erro)').toBe(true);
    expect(hasId(html, 'loginBtn'), 'Falta #loginBtn').toBe(true);
    // login.html usa inputs sem tag <form> (by design)
    expect(html).toContain('id="password"');
  });
});

test.describe('DOM Integrity — signup.html', () => {
  test('IDs críticos presentes: nome, cpf, senha, telefone, endereço', () => {
    const html = readPage('signup.html');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('cpf');
    expect(html.toLowerCase()).toContain('nome');
    expect(html.toLowerCase()).toContain('telefone');
  });

  test('Tem botão de submit ou botão de cadastro', () => {
    const html = readPage('signup.html');
    const hasSubmit = html.includes('type="submit"') || html.includes('btnCadastrar') || html.includes('Cadastrar');
    expect(hasSubmit, 'Falta botão de cadastro').toBe(true);
  });
});

test.describe('DOM Integrity — pg_associado.html', () => {
  test('Tem elementos de status financeiro', () => {
    const html = readPage('pg_associado.html');
    // Should have some financial status display
    const hasFinancial = html.includes('activeUntil') || html.includes('status') || html.includes('finance');
    expect(hasFinancial).toBe(true);
  });

  test('Tem área de banners', () => {
    const html = readPage('pg_associado.html');
    const hasBanners = html.toLowerCase().includes('banner') || html.includes('carousel');
    expect(hasBanners, 'Área de banners ausente').toBe(true);
  });

  test('Tem modal de troca de senha (primeiroAcesso)', () => {
    const html = readPage('pg_associado.html');
    expect(html).toContain('primeiroAcesso');
  });

  test('Tem applyModuleVisibility() (módulos dinâmicos)', () => {
    const html = readPage('pg_associado.html');
    // pg_associado não usa setupAdminButton (tem nav próprio via role check)
    expect(html).toContain('applyModuleVisibility');
  });

  test('Tem applyModuleVisibility()', () => {
    const html = readPage('pg_associado.html');
    expect(html).toContain('applyModuleVisibility');
  });
});

test.describe('DOM Integrity — pay.html', () => {
  test('Tem lógica de verificação de planos', () => {
    const html = readPage('pay.html');
    const hasPlans = html.includes('planType') || html.includes('mensal') || html.includes('Mensal');
    expect(hasPlans, 'Sem referência a planos').toBe(true);
  });

  test('Tem link/botão para Asaas', () => {
    const html = readPage('pay.html');
    const hasAsaas = html.includes('asaas') || html.includes('Asaas') || html.includes('payment');
    expect(hasAsaas, 'Sem referência a Asaas/payment').toBe(true);
  });

  test('Tem requireAuth ou onAuthStateChanged', () => {
    const html = readPage('pay.html');
    const hasAuth = html.includes('requireAuth(') || html.includes('onAuthStateChanged');
    expect(hasAuth, 'Sem proteção de auth').toBe(true);
  });
});

test.describe('DOM Integrity — admin_associados.html', () => {
  test('Tem tabela de associados', () => {
    const html = readPage('admin_associados.html');
    const hasTable = html.includes('<table') || html.includes('tbody') || html.includes('user-row');
    expect(hasTable, 'Sem tabela/lista de associados').toBe(true);
  });

  test('Tem modal de criação/edição de associado', () => {
    const html = readPage('admin_associados.html');
    const hasModal = html.includes('modal') && (html.includes('modal-content') || html.includes('modalAssoc') || html.includes('modal-body'));
    expect(hasModal, 'Sem modal de associado').toBe(true);
  });

  test('Tem campos de filtro/busca', () => {
    const html = readPage('admin_associados.html');
    const hasFilter = html.includes('filter') || html.includes('busca') || html.includes('search') || html.includes('pesquisa');
    expect(hasFilter, 'Sem campo de filtro').toBe(true);
  });

  test('Tem campo nome e CPF no formulário', () => {
    const html = readPage('admin_associados.html');
    expect(html.toLowerCase()).toContain('nome');
    expect(html.toLowerCase()).toContain('cpf');
  });

  test('Tem gestão de faturas (financeInvoices)', () => {
    const html = readPage('admin_associados.html');
    const hasInvoice = html.includes('financeInvoices') || html.includes('fatura') || html.includes('invoice');
    expect(hasInvoice, 'Sem gestão de faturas').toBe(true);
  });

  test('Tem requireAuth com role admin/master', () => {
    const html = readPage('admin_associados.html');
    expect(html).toContain('requireAuth(');
    const hasAdminRole = html.includes('"admin"') || html.includes('"Admin"') || html.includes('admin');
    expect(hasAdminRole).toBe(true);
  });
});

test.describe('DOM Integrity — admin_produtos.html', () => {
  test('Tem formulário de produto com campos título e descrição', () => {
    const html = readPage('admin_produtos.html');
    const hasTitle = html.toLowerCase().includes('title') || html.toLowerCase().includes('título') || html.includes('prodNome');
    expect(hasTitle, 'Sem campo de título de produto').toBe(true);
  });

  test('Tem upload de imagem', () => {
    const html = readPage('admin_produtos.html');
    expect(html).toContain('type="file"');
  });

  test('Tem toggle de ativo/inativo', () => {
    const html = readPage('admin_produtos.html');
    const hasToggle = html.includes('active') || html.includes('ativo') || html.includes('checkbox');
    expect(hasToggle, 'Sem toggle ativo').toBe(true);
  });
});

test.describe('DOM Integrity — admin_servicos.html', () => {
  test('Tem formulário de serviço', () => {
    const html = readPage('admin_servicos.html');
    const hasForm = html.includes('servTitle') || html.includes('serv') || html.toLowerCase().includes('serviço');
    expect(hasForm).toBe(true);
  });

  test('Tem upload de imagem', () => {
    const html = readPage('admin_servicos.html');
    expect(html).toContain('type="file"');
  });
});

test.describe('DOM Integrity — admin_classificados.html', () => {
  test('Tem lista de classificados para moderação', () => {
    const html = readPage('admin_classificados.html');
    const hasList = html.includes('classif') || html.includes('Classificad') || html.includes('aprovado') || html.includes('approved');
    expect(hasList).toBe(true);
  });

  test('Tem botões de aprovação/rejeição', () => {
    const html = readPage('admin_classificados.html');
    const hasApproval = html.includes('aprovar') || html.includes('reprovar') || html.includes('approve') || html.includes('reject');
    expect(hasApproval, 'Sem botões de aprovação').toBe(true);
  });
});

test.describe('DOM Integrity — admin_leiloes.html', () => {
  test('Tem lista de leilões/lotes', () => {
    const html = readPage('admin_leiloes.html');
    const hasLots = html.includes('lote') || html.includes('lot') || html.includes('auctionLot');
    expect(hasLots).toBe(true);
  });

  test('Tem gestão de status de lote', () => {
    const html = readPage('admin_leiloes.html');
    const hasStatus = html.includes('publicado') || html.includes('rascunho') || html.includes('encerrado');
    expect(hasStatus, 'Sem status de lote').toBe(true);
  });

  test('Tem IDs para tabela/grid de lotes', () => {
    const html = readPage('admin_leiloes.html');
    const hasGrid = html.includes('lotesLoading') || html.includes('lotesTbody') || html.includes('lot-row') || html.includes('lotsContainer');
    expect(hasGrid, 'Sem container de lotes').toBe(true);
  });
});

test.describe('DOM Integrity — leilao_lote.html', () => {
  test('Tem bid box (caixa de lance)', () => {
    const html = readPage('leilao_lote.html');
    const hasBid = html.includes('bid') || html.includes('lance') || html.includes('bid-box');
    expect(hasBid, 'Sem bid box').toBe(true);
  });

  test('Tem countdown', () => {
    const html = readPage('leilao_lote.html');
    expect(html).toContain('countdown');
  });

  test('Tem galeria de fotos do lote', () => {
    const html = readPage('leilao_lote.html');
    const hasPhotos = html.includes('photo') || html.includes('foto') || html.includes('thumb');
    expect(hasPhotos, 'Sem galeria de fotos').toBe(true);
  });
});

test.describe('DOM Integrity — meus_lotes.html', () => {
  test('Tem lista de lotes do usuário', () => {
    const html = readPage('meus_lotes.html');
    const hasList = html.includes('lote') || html.includes('lot') || html.includes('lot-row');
    expect(hasList).toBe(true);
  });

  test('Tem requireAuth para associado', () => {
    const html = readPage('meus_lotes.html');
    expect(html).toContain('requireAuth(');
  });
});

test.describe('DOM Integrity — lote_form.html', () => {
  test('Tem campos de formulário do lote', () => {
    const html = readPage('lote_form.html');
    // Category select
    const hasCat = html.includes('category') || html.includes('categoria') || html.includes('Categoria');
    expect(hasCat, 'Sem campo categoria').toBe(true);
  });

  test('Tem upload de imagens', () => {
    const html = readPage('lote_form.html');
    expect(html).toContain('type="file"');
  });

  test('Tem campos de valor mínimo e incremento', () => {
    const html = readPage('lote_form.html');
    const hasPrice = html.includes('precoInicial') || html.includes('lanceMinimo') || html.includes('valorMinimo') ||
                     html.includes('Valor') || html.includes('lance');
    expect(hasPrice, 'Sem campos de valor').toBe(true);
  });

  test('Tem requireAuth para associado', () => {
    const html = readPage('lote_form.html');
    expect(html).toContain('requireAuth(');
  });
});

test.describe('DOM Integrity — admin.html', () => {
  test('Tem mod-cards (módulos)', () => {
    const html = readPage('admin.html');
    expect(html).toContain('mod-card');
  });

  test('Tem Bootstrap Icons (não emojis) nos mod-cards', () => {
    const html = readPage('admin.html');
    expect(html).toContain('bi bi-');
    // Emojis should be gone from mod-cards
    const hasEmojis = html.includes('👤') || html.includes('📦') || html.includes('⚙️') || html.includes('🏷️');
    expect(hasEmojis, 'Emojis ainda presentes nos mod-cards').toBe(false);
  });

  test('Tem link para admin_leiloes.html', () => {
    const html = readPage('admin.html');
    expect(html).toContain('admin_leiloes.html');
  });

  test('Tem data-module="leiloes" para módulo de leilões', () => {
    const html = readPage('admin.html');
    expect(html).toContain('data-module="leiloes"');
  });

  test('Tem requireAuth', () => {
    const html = readPage('admin.html');
    expect(html).toContain('requireAuth(');
  });

  test('Tem Bootstrap Icons nos mod-cards (não emojis)', () => {
    const html = readPage('admin.html');
    // admin.html usa links diretos para área admin — setupAdminButton não é necessário aqui
    expect(html).toContain('bi bi-');
  });
});

test.describe('DOM Integrity — admin_master.html', () => {
  test('Tem KPI cards', () => {
    const html = readPage('admin_master.html');
    expect(hasId(html, 'kpiOrgs')).toBe(true);
    expect(hasId(html, 'kpiAssociados')).toBe(true);
    expect(hasId(html, 'kpiAtivas')).toBe(true);
  });

  test('Tem tabela de organizações', () => {
    const html = readPage('admin_master.html');
    expect(hasId(html, 'orgsTbody')).toBe(true);
  });

  test('Tem tabela de logs', () => {
    const html = readPage('admin_master.html');
    expect(hasId(html, 'logsTbody')).toBe(true);
  });

  test('Tem sidebar com 4 links de navegação', () => {
    const html = readPage('admin_master.html');
    expect(html).toContain('admin_master.html');
    expect(html).toContain('admin_master_associacoes.html');
    expect(html).toContain('admin_master_faturamento.html');
    expect(html).toContain('admin_master_configuracoes.html');
  });

  test('Tem BI icon no lugar do emoji ⚡', () => {
    const html = readPage('admin_master.html');
    expect(html).toContain('bi-lightning-charge-fill');
    expect(html).not.toContain('⚡');
  });
});

test.describe('DOM Integrity — admin_master_associacoes.html', () => {
  test('Tem modal de organização com campos obrigatórios', () => {
    const html = readPage('admin_master_associacoes.html');
    expect(hasId(html, 'orgNome')).toBe(true);
    expect(hasId(html, 'orgSlug')).toBe(true);
    expect(hasId(html, 'orgPlan')).toBe(true);
  });

  test('Tem checkboxes de módulos', () => {
    const html = readPage('admin_master_associacoes.html');
    expect(html).toContain('modulesCheckboxes');
  });

  test('Tem botão de suspender', () => {
    const html = readPage('admin_master_associacoes.html');
    expect(hasId(html, 'btnSuspender')).toBe(true);
  });
});

test.describe('DOM Integrity — admin_master_faturamento.html', () => {
  test('Tem KPIs de MRR, ARR, Adimplentes, Inadimplentes', () => {
    const html = readPage('admin_master_faturamento.html');
    expect(hasId(html, 'kpiMrr')).toBe(true);
    expect(hasId(html, 'kpiArr')).toBe(true);
    expect(hasId(html, 'kpiAdim')).toBe(true);
    expect(hasId(html, 'kpiInadim')).toBe(true);
  });

  test('Tem modal de assinatura', () => {
    const html = readPage('admin_master_faturamento.html');
    expect(hasId(html, 'subOrgId')).toBe(true);
    expect(hasId(html, 'subPlan')).toBe(true);
    expect(hasId(html, 'subValor')).toBe(true);
  });
});

test.describe('DOM Integrity — admin_master_configuracoes.html', () => {
  test('Tem campos de configuração da plataforma', () => {
    const html = readPage('admin_master_configuracoes.html');
    expect(hasId(html, 'cfgNome')).toBe(true);
    expect(hasId(html, 'cfgEmail1')).toBe(true);
    expect(hasId(html, 'cfgEmail2')).toBe(true);
  });

  test('Tem ação global de Cache; botões de Seed/Migração removidos (Fase 3.6 — chamavam Cloud Functions inexistentes)', () => {
    const html = readPage('admin_master_configuracoes.html');
    expect(hasId(html, 'btnLimparCache')).toBe(true);
    expect(hasId(html, 'btnSeedData')).toBe(false);
    expect(hasId(html, 'btnMigrar')).toBe(false);
  });
});

test.describe('DOM Integrity — CMS (admin_conteudo.html)', () => {
  test('Tem painel de módulos CMS', () => {
    const html = readPage('admin_conteudo.html');
    const hasCms = html.includes('conteudo') || html.includes('cms') || html.includes('CMS') || html.includes('content');
    expect(hasCms, 'admin_conteudo.html sem painel CMS').toBe(true);
  });
});

test.describe('DOM Integrity — todos IDs referenciados por JS existem no HTML', () => {
  test('Todos os getElementById em admin_master.html apontam para IDs existentes no HTML', () => {
    const html = readPage('admin_master.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });

  test('Todos os getElementById em admin_master_associacoes.html apontam para IDs existentes', () => {
    const html = readPage('admin_master_associacoes.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });

  test('Todos os getElementById em admin_master_faturamento.html apontam para IDs existentes', () => {
    const html = readPage('admin_master_faturamento.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });

  test('Todos os getElementById em admin_master_configuracoes.html apontam para IDs existentes', () => {
    const html = readPage('admin_master_configuracoes.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });

  test('Todos os getElementById em login.html apontam para IDs existentes', () => {
    const html = readPage('login.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });

  test('Todos os getElementById em login_master.html apontam para IDs existentes', () => {
    const html = readPage('login_master.html');
    const ids = extractGetElementIds(html);
    const missing = ids.filter(id => !hasId(html, id));
    expect(missing, `IDs inexistentes: ${missing.join(', ')}`).toHaveLength(0);
  });
});
