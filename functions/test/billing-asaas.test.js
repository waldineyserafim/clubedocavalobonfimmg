// Testa lib/billing/asaas.js com fetch mockado — NUNCA toca a API real do Asaas
// (nem sandbox: não há chave de sandbox configurada neste projeto).
const assert = require('assert');
const { createAsaasBillingProvider, SANDBOX_BASE_URL, DEFAULT_BASE_URL } = require('../lib/billing/asaas');

function makeMockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const match = responses.find(r => r.when(url, opts));
    if (!match) throw new Error(`mock fetch: nenhuma resposta configurada para ${opts.method || 'GET'} ${url}`);
    return {
      ok: match.status < 400,
      status: match.status,
      text: async () => JSON.stringify(match.body),
    };
  };
  return { fetchImpl, calls };
}

module.exports = async function run({ t }) {
  // Fase 3.4 — organizations/{orgId}.billingEnvironment conectado de verdade
  // (não só salvo e ignorado): "sandbox" precisa realmente rotear pra
  // sandbox.asaas.com, não só parecer que roteia.
  await t('environment "sandbox" usa SANDBOX_BASE_URL de verdade', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: () => true, status: 200, body: { id: 'cus_123' } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', environment: 'sandbox', fetchImpl });
    await provider.createCustomer({ name: 'Fulano', cpfCnpj: '12345678900', externalReference: 'uid1' });
    assert.ok(calls[0].url.startsWith(SANDBOX_BASE_URL), `esperava URL começando com ${SANDBOX_BASE_URL}, recebeu ${calls[0].url}`);
  });

  await t('environment ausente (organização sem o campo) continua batendo em produção — retrocompatível', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: () => true, status: 200, body: { id: 'cus_123' } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    await provider.createCustomer({ name: 'Fulano', cpfCnpj: '12345678900', externalReference: 'uid1' });
    assert.ok(calls[0].url.startsWith(DEFAULT_BASE_URL), `esperava URL começando com ${DEFAULT_BASE_URL}, recebeu ${calls[0].url}`);
  });

  await t('createCustomer monta o payload certo e retorna providerId', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: (url, o) => url.endsWith('/customers') && o.method === 'POST', status: 200, body: { id: 'cus_123' } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const { providerId } = await provider.createCustomer({ name: 'Fulano', cpfCnpj: '12345678900', externalReference: 'uid1' });
    assert.strictEqual(providerId, 'cus_123');
    assert.strictEqual(calls[0].body.externalReference, 'uid1');
  });

  await t('findOrCreateCustomer prioriza externalReference sobre CPF', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: (url) => url.includes('externalReference='), status: 200, body: { data: [{ id: 'cus_found_by_ref' }] } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const result = await provider.findOrCreateCustomer({ name: 'Fulano', cpfCnpj: '12345678900', externalReference: 'uid1' });
    assert.strictEqual(result.providerId, 'cus_found_by_ref');
    assert.strictEqual(result.action, 'found');
    assert.strictEqual(calls.length, 1, 'não deveria ter tentado buscar por CPF depois de achar por externalReference');
  });

  await t('findOrCreateCustomer cai para CPF quando não acha por externalReference', async () => {
    const { fetchImpl } = makeMockFetch([
      { when: (url) => url.includes('externalReference='), status: 200, body: { data: [] } },
      { when: (url) => url.includes('cpfCnpj='), status: 200, body: { data: [{ id: 'cus_found_by_cpf' }] } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const result = await provider.findOrCreateCustomer({ name: 'Fulano', cpfCnpj: '12345678900', externalReference: 'uid1' });
    assert.strictEqual(result.providerId, 'cus_found_by_cpf');
  });

  await t('findOrCreateCustomer NÃO usa fallback de CPF quando allowDocumentFallback=false (caso mirim)', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: (url) => url.includes('externalReference='), status: 200, body: { data: [] } },
      { when: (url) => url.endsWith('/customers') , status: 200, body: { id: 'cus_created_mirim' } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const result = await provider.findOrCreateCustomer({
      name: 'Mirim', cpfCnpj: '12345678900', externalReference: 'uid_mirim', allowDocumentFallback: false,
    });
    assert.strictEqual(result.action, 'created');
    assert.ok(!calls.some(c => c.url.includes('cpfCnpj=')), 'não deveria ter buscado por CPF quando allowDocumentFallback é false');
  });

  await t('mapPaymentStatus traduz status do Asaas para o vocabulário local', async () => {
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl: async () => ({ ok: true, text: async () => '{}' }) });
    assert.strictEqual(provider.mapPaymentStatus({ status: 'RECEIVED' }), 'pago');
    assert.strictEqual(provider.mapPaymentStatus({ status: 'OVERDUE' }), 'atrasado');
    assert.strictEqual(provider.mapPaymentStatus({ status: 'PENDING' }), 'em_aberto');
    assert.strictEqual(provider.mapPaymentStatus({ status: 'REFUNDED' }), 'estornado');
    assert.strictEqual(provider.mapPaymentStatus({ status: 'RECEIVED', deleted: true }), 'cancelado');
  });

  await t('deleteCustomer chama DELETE no endpoint certo e retorna deleted:true (Fase 2C)', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: (url, o) => url.includes('/customers/cus_1') && o.method === 'DELETE', status: 200, body: { deleted: true } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const { deleted } = await provider.deleteCustomer('cus_1');
    assert.strictEqual(deleted, true);
    assert.strictEqual(calls[0].method, 'DELETE');
  });

  await t('cancelCharge chama DELETE no endpoint certo', async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { when: (url, o) => url.includes('/payments/pay_1') && o.method === 'DELETE', status: 200, body: { deleted: true } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const { deleted } = await provider.cancelCharge('pay_1');
    assert.strictEqual(deleted, true);
    assert.strictEqual(calls[0].method, 'DELETE');
  });

  await t('request lança erro com a mensagem do Asaas quando a resposta não é ok', async () => {
    const { fetchImpl } = makeMockFetch([
      { when: () => true, status: 400, body: { errors: [{ description: 'CPF inválido' }] } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    await assert.rejects(() => provider.createCustomer({ name: 'X', cpfCnpj: '000' }), /CPF inválido/);
  });

  await t('healthCheck retorna ok:false em vez de lançar quando a API falha', async () => {
    const { fetchImpl } = makeMockFetch([
      { when: () => true, status: 500, body: { errors: [{ description: 'fora do ar' }] } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const result = await provider.healthCheck();
    assert.strictEqual(result.ok, false);
  });

  await t('processWebhook confirma pagamento e resolve externalReference da assinatura', async () => {
    const { fetchImpl } = makeMockFetch([
      { when: (url) => url.includes('/payments/pay_1') && !url.includes('subscriptions'), status: 200, body: { id: 'pay_1', status: 'RECEIVED', value: 30, dueDate: '2026-01-10' } },
      { when: (url) => url.includes('/subscriptions/sub_1'), status: 200, body: { id: 'sub_1', externalReference: 'uid_42' } },
    ]);
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl });
    const result = await provider.processWebhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', subscription: 'sub_1' } });
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.subscriptionExternalReference, 'uid_42');
  });

  await t('processWebhook ignora eventos que não são de recebimento', async () => {
    const provider = createAsaasBillingProvider({ apiKey: 'fake', fetchImpl: async () => { throw new Error('não deveria chamar a API'); } });
    const result = await provider.processWebhook({ event: 'PAYMENT_CREATED', payment: { id: 'pay_1' } });
    assert.strictEqual(result.confirmed, false);
  });
};
