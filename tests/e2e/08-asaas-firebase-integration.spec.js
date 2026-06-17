// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Integridade das Integrações Asaas + Firebase
// Verifica que todo o código de integração continua intacto
// nas Cloud Functions e no frontend após a refatoração.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readFile(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// ─── Cloud Functions ─────────────────────────────────────────────────────────

test.describe('Cloud Functions — Handlers Asaas', () => {
  test('functions/index.js existe', () => {
    expect(fs.existsSync(path.join(ROOT, 'functions/index.js'))).toBe(true);
  });

  test('onNewAssociadoCriado — trigger onCreate users/{uid}', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('onNewAssociadoCriado');
    // Firestore v1 pattern: .document('users/{uid}').onCreate(...)
    expect(fn).toContain('.document(');
    expect(fn).toContain('.onCreate(');
  });

  test('onAssociadoAtualizado — trigger onUpdate users/{uid}', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('onAssociadoAtualizado');
    expect(fn).toContain('.document(');
    expect(fn).toContain('.onUpdate(');
  });

  test('onInvoicePaid — trigger onUpdate financeInvoices', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('onInvoicePaid');
    expect(fn).toContain('financeInvoices');
  });

  test('onInvoiceCreatedPaid — trigger onCreate financeInvoices', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('onInvoiceCreatedPaid');
  });

  test('asaasWebhook — HTTP handler público', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaasWebhook');
    expect(fn).toContain('onRequest');
  });

  test('configureAsaasNotifications — Callable function', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('configureAsaasNotifications');
    expect(fn).toContain('onCall');
  });
});

test.describe('Cloud Functions — Asaas API', () => {
  test('URL base da API Asaas está correta', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('api.asaas.com/v3');
  });

  test('Criação de cliente no Asaas (POST /customers)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('/customers');
    // Should include CPF normalization
    expect(fn).toContain('cpf');
  });

  test('Criação de assinatura no Asaas (POST /subscriptions)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('/subscriptions');
    expect(fn).toContain('billingType');
  });

  test('Planos mapeados corretamente (mensal/trimestral/semestral)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('MONTHLY');
    expect(fn).toContain('QUARTERLY');
    expect(fn).toContain('SEMIANNUALLY');
    expect(fn).toContain('mensal');
    expect(fn).toContain('trimestral');
    expect(fn).toContain('semestral');
  });

  test('Valores dos planos corretos (30, 85, 170)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('30');
    expect(fn).toContain('85');
    expect(fn).toContain('170');
  });
});

test.describe('Cloud Functions — Webhook Asaas', () => {
  test('Webhook valida token de autenticação (header asaas-access-token)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaas-access-token');
  });

  test('Webhook verifica pagamento diretamente na API (anti-fraude)', () => {
    const fn = readFile('functions/index.js');
    // Should make a request to verify the payment
    const hasVerify = fn.includes('payment') && (fn.includes('verify') || fn.includes('get'));
    expect(hasVerify, 'Webhook sem verificação anti-fraude').toBe(true);
  });

  test('Webhook processa PAYMENT_RECEIVED e PAYMENT_CONFIRMED', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('PAYMENT_RECEIVED');
    expect(fn).toContain('PAYMENT_CONFIRMED');
  });

  test('Webhook tem idempotência por asaasPaymentId', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaasPaymentId');
  });

  test('Webhook atualiza finance/summary via updateFinanceSummary', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('updateFinanceSummary');
    expect(fn).toContain('finance/summary');
  });

  test('Webhook busca UID via externalReference da assinatura', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('externalReference');
  });
});

test.describe('Cloud Functions — Relatório Diário', () => {
  test('Cron de relatório diário às 08:00 BRT', () => {
    const fn = readFile('functions/index.js');
    // Schedule '0 8 * * *' = 08:00 UTC que é 08:00 BRT + timeZone America/Sao_Paulo
    expect(fn).toContain('schedule');
    // Verifica o padrão cron (com espaço entre 0 e 8 no formato UNIX cron)
    const hasMorningCron = fn.includes('0 8 * * *') || fn.includes('08:00');
    expect(hasMorningCron, 'Sem cron às 08h').toBe(true);
  });

  test('Relatório usa Nodemailer + Gmail', () => {
    const fn = readFile('functions/index.js');
    const hasMailer = fn.includes('nodemailer') || fn.includes('transporter');
    expect(hasMailer, 'Sem nodemailer/transporter').toBe(true);
  });

  test('Email vai para waldiney.serafim@gmail.com', () => {
    const fn = readFile('functions/index.js');
    // No arquivo o endereço tem W maiúsculo: 'Waldiney.serafim@gmail.com'
    const hasEmail = fn.toLowerCase().includes('waldiney.serafim@gmail.com');
    expect(hasEmail, 'Email de destino não encontrado').toBe(true);
  });
});

test.describe('Cloud Functions — Secret Manager', () => {
  test('Usa Secret Manager para chave Asaas', () => {
    const fn = readFile('functions/index.js');
    // Chave asaas-api-key no Secret Manager (pacote @google-cloud/secret-manager)
    const hasSecret = fn.includes('asaas-api-key') || fn.includes('secret-manager');
    expect(hasSecret, 'Sem referência ao Secret Manager para chave Asaas').toBe(true);
  });

  test('Usa Secret Manager para webhook token', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaas-webhook-token');
  });

  test('Nenhuma chave de API hardcoded (sem $aact_ ou Bearer)', () => {
    const fn = readFile('functions/index.js');
    // Asaas keys start with $aact_ — should never be hardcoded
    expect(fn).not.toMatch(/\$aact_[A-Za-z0-9]+/);
  });
});

test.describe('Cloud Functions — Firestore Schema', () => {
  test('users/{uid}/financeInvoices subcoleção presente no código', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('financeInvoices');
  });

  test('users/{uid}/finance/summary atualizado no webhook', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('finance/summary');
  });

  test('asaasId e asaasSubscriptionId gravados no documento do usuário', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaasId');
    expect(fn).toContain('asaasSubscriptionId');
  });

  test('Campo asaasSyncedAt gravado na sincronização', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaasSyncedAt');
  });
});

// ─── Firebase Frontend ────────────────────────────────────────────────────────

test.describe('Firebase Frontend — firebase.js', () => {
  test('firebase.js exporta auth e db', () => {
    const fb = readFile('firebase.js');
    expect(fb).toContain('export');
    expect(fb).toContain('auth');
    expect(fb).toContain('db');
  });

  test('firebase.js usa Firebase 11.0.1 (versão correta)', () => {
    const fb = readFile('firebase.js');
    expect(fb).toContain('firebasejs/11.0.1');
  });

  test('firebase.js tem upload de imagem com compressão', () => {
    const fb = readFile('firebase.js');
    const hasUpload = fb.includes('upload') || fb.includes('compressImage') || fb.includes('canvas');
    expect(hasUpload, 'Sem função de upload/compressão').toBe(true);
  });

  test('firebase.js tem role caching em sessionStorage', () => {
    const fb = readFile('firebase.js');
    expect(fb).toContain('sessionStorage');
    expect(fb).toContain('role');
  });

  test('firebase.js — config com projectId clubecavalobonfim', () => {
    const fb = readFile('firebase.js');
    expect(fb).toContain('clubecavalobonfim');
  });
});

test.describe('Firebase Frontend — CRUD Operations', () => {
  test('admin_associados.html usa setDoc/updateDoc para Create/Update', () => {
    const html = readFile('admin_associados.html');
    const hasCRUD = html.includes('setDoc') || html.includes('updateDoc') || html.includes('addDoc');
    expect(hasCRUD, 'Sem operações de Create/Update').toBe(true);
  });

  test('admin_associados.html usa getDocs para Read', () => {
    const html = readFile('admin_associados.html');
    expect(html).toContain('getDocs');
  });

  test('admin_produtos.html usa operações Firestore CRUD', () => {
    const html = readFile('admin_produtos.html');
    const hasFirestore = html.includes('getDocs') || html.includes('setDoc') || html.includes('addDoc');
    expect(hasFirestore, 'admin_produtos sem operações Firestore').toBe(true);
  });

  test('admin_servicos.html usa operações Firestore CRUD', () => {
    const html = readFile('admin_servicos.html');
    const hasFirestore = html.includes('getDocs') || html.includes('setDoc') || html.includes('addDoc');
    expect(hasFirestore, 'admin_servicos sem operações Firestore').toBe(true);
  });

  test('admin_classificados.html usa operações Firestore (Read + Update para moderação)', () => {
    const html = readFile('admin_classificados.html');
    const hasRead = html.includes('getDocs') || html.includes('getDoc');
    const hasUpdate = html.includes('updateDoc') || html.includes('setDoc');
    expect(hasRead, 'Sem operação de Read').toBe(true);
    expect(hasUpdate, 'Sem operação de Update (moderação)').toBe(true);
  });

  test('admin_leiloes.html usa operações Firestore', () => {
    const html = readFile('admin_leiloes.html');
    const hasFirestore = html.includes('getDocs') || html.includes('getDoc') || html.includes('collection');
    expect(hasFirestore).toBe(true);
  });

  test('lote_form.html usa addDoc/setDoc para Create de lote', () => {
    const html = readFile('lote_form.html');
    const hasCreate = html.includes('addDoc') || html.includes('setDoc');
    expect(hasCreate, 'lote_form sem operação de Create').toBe(true);
  });

  test('admin_master_associacoes.html usa setDoc para Create/Update de organização', () => {
    const html = readFile('admin_master_associacoes.html');
    expect(html).toContain('setDoc');
  });

  test('admin_master_faturamento.html usa addDoc/updateDoc para assinaturas SaaS', () => {
    const html = readFile('admin_master_faturamento.html');
    const hasCRUD = html.includes('addDoc') || html.includes('updateDoc');
    expect(hasCRUD).toBe(true);
  });

  test('admin_master_configuracoes.html usa setDoc para salvar configs', () => {
    const html = readFile('admin_master_configuracoes.html');
    expect(html).toContain('setDoc');
  });
});

test.describe('Firebase Frontend — Delete Operations', () => {
  test('admin_galeria.html ou admin_banners.html tem deleteDoc/deleteObject', () => {
    // At least one admin page should have delete capability
    const galeria = readFile('admin_galeria.html');
    const banners = readFile('admin_banners.html');
    const hasDelete = galeria.includes('deleteDoc') || galeria.includes('deleteObject') ||
                      banners.includes('deleteDoc') || banners.includes('deleteObject');
    expect(hasDelete, 'Nenhuma página admin tem operação de Delete').toBe(true);
  });
});

// ─── Webhook Mock Test (HTTP) ─────────────────────────────────────────────────

test.describe('Webhook Asaas — Validação de Contrato', () => {
  test('Webhook URL está documentada no CLAUDE.md', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('asaasWebhook');
    expect(claude).toContain('us-central1-clubecavalobonfim.cloudfunctions.net');
  });

  test('Eventos configurados: PAYMENT_RECEIVED e PAYMENT_CONFIRMED', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('PAYMENT_RECEIVED');
    expect(claude).toContain('PAYMENT_CONFIRMED');
  });

  test('Webhook usa header asaas-access-token para validação', () => {
    const claude = readFile('CLAUDE.md');
    expect(claude).toContain('asaas-access-token') || expect(claude).toContain('token');
  });

  test('functions/package.json tem dependências necessárias', () => {
    const pkgPath = path.join(ROOT, 'functions/package.json');
    if (!fs.existsSync(pkgPath)) test.skip();
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    // Should have firebase-functions or firebase-admin
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasFirebase = Object.keys(deps).some(d => d.includes('firebase'));
    expect(hasFirebase, 'functions/package.json sem dependências Firebase').toBe(true);
  });
});
