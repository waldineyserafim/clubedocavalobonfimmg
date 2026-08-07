// Testa lib/billing/index.js — resolução de provider por organização e o
// registro extensível (Fase 2C, escopo item 3: "preparar arquitetura para
// múltiplos Billing Providers sem implementar nenhum novo").
const assert = require('assert');
const { getBillingProvider, registerBillingProvider, _unregisterBillingProviderForTests } = require('../lib/billing');

module.exports = async function run({ t }) {
  await t('getBillingProvider resolve "asaas" por default quando a org não define billingProvider', async () => {
    const provider = await getBillingProvider({
      org: null,
      getSecret: async () => 'fake-key',
      defaultSecretName: 'default-secret',
    });
    assert.strictEqual(provider.id, 'asaas');
  });

  await t('getBillingProvider usa org.billingConfig.secretName quando presente', async () => {
    let secretUsed = null;
    await getBillingProvider({
      org: { billingConfig: { secretName: 'secret-da-org-b' } },
      getSecret: async (name) => { secretUsed = name; return 'fake-key'; },
      defaultSecretName: 'default-secret',
    });
    assert.strictEqual(secretUsed, 'secret-da-org-b');
  });

  await t('getBillingProvider cai no defaultSecretName quando a org não tem billingConfig próprio', async () => {
    let secretUsed = null;
    await getBillingProvider({
      org: { nome: 'Org sem config de billing própria' },
      getSecret: async (name) => { secretUsed = name; return 'fake-key'; },
      defaultSecretName: 'default-secret',
    });
    assert.strictEqual(secretUsed, 'default-secret');
  });

  await t('getBillingProvider lança erro claro para provider não registrado', async () => {
    await assert.rejects(
      () => getBillingProvider({ org: { billingProvider: 'stripe' }, getSecret: async () => 'x', defaultSecretName: 'x' }),
      /não registrado/
    );
  });

  await t('registerBillingProvider permite um novo provider se registrar sem editar lib/billing/index.js', async () => {
    registerBillingProvider('fake-gateway', ({ apiKey }) => ({ id: 'fake-gateway', apiKey }));
    try {
      const provider = await getBillingProvider({
        org: { billingProvider: 'fake-gateway' },
        getSecret: async () => 'chave-do-fake-gateway',
        defaultSecretName: 'default-secret',
      });
      assert.strictEqual(provider.id, 'fake-gateway');
      assert.strictEqual(provider.apiKey, 'chave-do-fake-gateway');
    } finally {
      _unregisterBillingProviderForTests('fake-gateway');
    }
  });
};
