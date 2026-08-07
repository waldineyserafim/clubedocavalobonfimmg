// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Central Financeira Asaas — Admin → Associados
// Testes de contrato estáticos (mesmo estilo de 08-asaas-firebase-integration.spec.js):
// leem o código fonte e verificam que as peças esperadas existem, sem subir app
// nem tocar Firebase/Asaas de verdade.
// ============================================================

const ROOT = path.join(__dirname, '../..');
function readFile(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// Fase 2B (Billing Provider) + Fase 2C (Organization Resolver/Authorization
// Helpers) reestruturaram como estas functions checam permissão e chamam o
// Asaas — as asserções abaixo foram atualizadas para a forma real atual
// (ver docs/FASE2B_CLOUD_FUNCTIONS_MIGRATION_REPORT.md e
// docs/FASE2C_MULTI_TENANT_FINALIZATION_REPORT.md), preservando a mesma
// propriedade que cada teste sempre verificou.
test.describe('Cloud Functions — Central Financeira (novas)', () => {
  test('upsertInvoiceFromAsaasPayment — helper único de reconciliação, usado pelo webhook', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('async function upsertInvoiceFromAsaasPayment(uid, normalizedPayment)');
    expect(fn).toContain('billingType:    normalizedPayment.billingType || null');
    expect(fn).toContain('invoiceNumber:  normalizedPayment.invoiceNumber || null');
    // usado dentro do asaasWebhook (via o payment já normalizado pelo Billing Provider), não duplicado
    const webhookIdx = fn.indexOf('exports.asaasWebhook');
    const webhookBody = fn.slice(webhookIdx, webhookIdx + 3000);
    expect(webhookBody).toContain('upsertInvoiceFromAsaasPayment(uid, result.payment)');
  });

  test('syncOneAssociado — helper único de sincronização, reusado pela callable e pelo scheduler, agora recebe o provider já resolvido', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('async function syncOneAssociado(provider, uid, { manual = false } = {})');
    expect(fn).toContain("'asaasSync.lastSyncedAt'");
    expect(fn).toContain("'asaasSync.lastSyncResult'");
    expect(fn).toContain("'asaasSync.lastApiCheckAt'");
    expect(fn).toContain("'asaasSync.lastApiCheckStatus'");
  });

  test('asaasSyncAssociado — Callable, requer admin/master da MESMA organização do alvo, chama syncOneAssociado(provider, uid, {manual:true})', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('exports.asaasSyncAssociado');
    expect(fn).toContain('onCall');
    const idx = fn.indexOf('exports.asaasSyncAssociado');
    const body = fn.slice(idx, idx + 1200);
    expect(body).toContain('auth.requireOrganizationAdmin(context)');
    expect(body).toContain('auth.assertCallerCanManageTarget(caller, data?.uid)');
    expect(body).toContain('syncOneAssociado(provider, data.uid, { manual: true })');
  });

  test('asaasCreatePayment — Callable, requer admin/master da MESMA organização do alvo, cria cobrança via Billing Provider', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('exports.asaasCreatePayment');
    const idx = fn.indexOf('exports.asaasCreatePayment');
    const body = fn.slice(idx, idx + 1800);
    expect(body).toContain('auth.requireOrganizationAdmin(context)');
    expect(body).toContain('auth.assertCallerCanManageTarget(caller, data?.uid)');
    expect(body).toContain('provider.createCharge(');
  });

  test('asaasCancelPayment — Callable, requer admin/master da MESMA organização do alvo, cancela via Billing Provider, marca invoice local como cancelado', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('exports.asaasCancelPayment');
    const idx = fn.indexOf('exports.asaasCancelPayment');
    const body = fn.slice(idx, idx + 1800);
    expect(body).toContain('auth.requireOrganizationAdmin(context)');
    expect(body).toContain('auth.assertCallerCanManageTarget(caller, data?.uid)');
    expect(body).toContain('provider.cancelCharge(');
    expect(body).toContain("status: 'cancelado'");
  });

  test('asaasGetPaymentStatus — Callable somente leitura, consulta via Billing Provider', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('exports.asaasGetPaymentStatus');
    const idx = fn.indexOf('exports.asaasGetPaymentStatus');
    const body = fn.slice(idx, idx + 1200);
    expect(body).toContain('auth.requireOrganizationAdmin(context)');
    expect(body).toContain('provider.getCharge(asaasPaymentId)');
  });

  test('asaasReconciliationDaily — agendada de madrugada, processa organização por organização, só reconcilia (sem criar/cancelar cobrança)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('exports.asaasReconciliationDaily');
    const idx = fn.indexOf('exports.asaasReconciliationDaily');
    const body = fn.slice(idx, idx + 2200);
    expect(body).toContain('.pubsub.schedule(');
    expect(body).toContain("timeZone('America/Sao_Paulo')");
    // Fase 2B: itera organizations e filtra users por orgId — antes lia `users` inteiro sem filtro.
    expect(body).toContain("db.collection('organizations')");
    expect(body).toContain("db.collection('users').where('orgId', '==', org.id)");
    expect(body).toContain('syncOneAssociado(provider, userDoc.id, { manual: false })');
    // não deve chamar as rotas de mutação (create/cancel) dentro do escopo da function
    expect(body).not.toContain('asaasCreatePayment(');
    expect(body).not.toContain('asaasCancelPayment(');
  });

  test('Webhook continua validando token e verificando pagamento na API (anti-fraude) após o refactor', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('asaas-access-token');
    expect(fn).toContain('defaultProvider.processWebhook({ event, payment })');
    // a checagem RECEIVED/CONFIRMED (anti-fraude) agora mora no Billing Provider,
    // não mais em index.js — ver mapPaymentStatus em lib/billing/asaas.js.
    const provider = readFile('functions/lib/billing/asaas.js');
    expect(provider).toContain("case 'RECEIVED':");
    expect(provider).toContain("case 'CONFIRMED':");
  });
});

test.describe('Firestore Schema — Central Financeira (novos campos)', () => {
  test('firestore.rules bloqueia escrita de asaasSync pelo cliente', () => {
    const rules = readFile('firestore.rules');
    const idx = rules.indexOf('function noSensitiveFieldChange');
    const body = rules.slice(idx, idx + 500);
    expect(body).toContain('"asaasSync"');
  });

  test('financeInvoices ganham billingType/invoiceNumber nas rotinas de sincronização', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('billingType:    normalizedPayment.billingType || null');
    expect(fn).toContain('billingType:    charge.billingType || null');
  });

  test('finance/summary ganha campos de status da assinatura (subscriptionStatus etc.)', () => {
    const fn = readFile('functions/index.js');
    expect(fn).toContain('subscriptionStatus:');
    expect(fn).toContain('subscriptionValue:');
    expect(fn).toContain('subscriptionCycle:');
    expect(fn).toContain('subscriptionBillingType:');
    expect(fn).toContain('subscriptionNextDueDate:');
  });
});

test.describe('Frontend — admin_associados.html (tabela + ações + modal)', () => {
  test('Tabela usa colunas Plano/Vigência/Situação/Cobrança/Ações (não mais Última Cobrança/Próx. Vencimento)', () => {
    const html = readFile('admin_associados.html');
    expect(html).toContain('col-plan');
    expect(html).toContain('col-vigencia');
    expect(html).toContain('col-status');
    expect(html).toContain('col-cobranca');
    expect(html).toContain('col-action');
    expect(html).not.toContain('col-lastpay');
    expect(html).not.toContain('col-value');
    expect(html).not.toContain('col-next');
  });

  test('Menu de ações por linha tem os 8 itens definidos no plano (sem SMS, sem "abrir no Asaas")', () => {
    const html = readFile('admin_associados.html');
    const expected = [
      'data-row-action="create-payment"',
      'data-row-action="cancel-payment"',
      'data-row-action="check-payment"',
      'data-row-action="copy-link"',
      'data-row-action="open-wpp"',
      'data-row-action="open-email"',
      'data-row-action="view-history"',
      'data-row-action="sync"',
    ];
    for (const item of expected) expect(html).toContain(item);
    expect(html).not.toContain('data-row-action="send-sms"');
  });

  test('Ações do painel chamam as Cloud Functions novas via httpsCallable', () => {
    const html = readFile('admin_associados.html');
    expect(html).toContain('httpsCallable(asaasFns, "asaasCreatePayment")');
    expect(html).toContain('httpsCallable(asaasFns, "asaasCancelPayment")');
    expect(html).toContain('httpsCallable(asaasFns, "asaasGetPaymentStatus")');
    expect(html).toContain('httpsCallable(asaasFns, "asaasSyncAssociado")');
  });

  test('Modal do associado usa Bootstrap Tabs com as 4 abas (não Offcanvas)', () => {
    const html = readFile('admin_associados.html');
    expect(html).toContain('data-bs-toggle="tab"');
    expect(html).toContain('renderCobrancaTab');
    expect(html).toContain('renderAuditoriaTab');
    expect(html).not.toContain('bootstrap.Offcanvas');
    // continua sendo modal-xl, não offcanvas
    expect(html).toContain('new bootstrap.Modal(userModalDiv)');
  });

  test('Aba Cobrança não afirma rastrear entrega de notificação (sem "entregue"/"falhou" como status de envio)', () => {
    const html = readFile('admin_associados.html');
    const idx = html.indexOf('function renderCobrancaTab');
    const body = html.slice(idx, idx + 3000);
    expect(body).not.toMatch(/entregue|falhou/i);
  });

  test('Nenhum toast/componente novo introduzido — mantém alert()/confirm() já usados no arquivo', () => {
    const html = readFile('admin_associados.html');
    expect(html).not.toContain('showToast(');
  });
});
