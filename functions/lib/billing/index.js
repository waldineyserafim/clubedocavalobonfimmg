// functions/lib/billing/index.js — resolução de qual Billing Provider uma organização usa.
//
// Hoje só existe o provider Asaas, mas nenhuma Cloud Function deve mais montar a
// chamada à API do Asaas diretamente — todas passam por aqui. Isso é o que
// permite, no futuro, uma organização diferente usar outro gateway sem tocar em
// nenhuma regra de negócio: só este arquivo muda.
//
// Contrato do Billing Provider (implementado por lib/billing/asaas.js hoje — o
// primeiro de potencialmente vários; nenhuma regra de negócio em index.js deve
// assumir "é Asaas", só usar os métodos abaixo):
//   findCustomerByExternalReference(ref) / findCustomerByDocument(doc)
//   createCustomer(data) / findOrCreateCustomer(data) / updateCustomer(id, updates) /
//   deleteCustomer(id)
//   createSubscription(data) / getSubscription(id) / updateSubscriptionStatus(id, status)
//   cancelSubscription(id) [=pausa reversível] / deleteSubscription(id) [=exclusão definitiva]
//   createCharge(data) / createPayment(data) [alias] / cancelCharge(id) / getCharge(id)
//   refundPayment(id) / receiveInCash(id, data) / listCharges(query) / listAllCustomers()
//   verifyWebhookToken(received, expected) / processWebhook({event, payment})
//   synchronize({customerId, subscriptionId}) / healthCheck()
//   mapPaymentStatus(payment) / normalizePayment(payment)
//
// Extensões específicas de provider (fora do contrato, ex.: `notifications` do
// Asaas) ficam expostas no objeto retornado, mas nenhuma regra de negócio comum
// deve depender delas sem checar `provider.id` antes.
//
// Fase 2C — preparar para múltiplos providers (Asaas, outros gateways, bancos)
// SEM implementar nenhum novo: o registro fica num Map mutável em vez de um
// objeto literal fixo, para um novo provider poder se registrar (ex.: de um
// arquivo `lib/billing/stripe.js` futuro chamando `registerBillingProvider`)
// sem precisar editar este arquivo. Nada aqui assume Asaas — 'asaas' é só a
// única entrada registrada até hoje.

const { createAsaasBillingProvider } = require('./asaas');

const providerFactories = new Map();

/** Registra um novo Billing Provider pelo id usado em `organizations/{orgId}.billingProvider`. */
function registerBillingProvider(id, factory) {
  providerFactories.set(id, factory);
}

/** Só para testes: remove um provider registrado. */
function _unregisterBillingProviderForTests(id) {
  providerFactories.delete(id);
}

registerBillingProvider('asaas', createAsaasBillingProvider);

/**
 * @param {object} opts
 * @param {object} [opts.org] — documento de organizations/{orgId}; se ausente ou sem
 *   `billingProvider`, usa 'asaas' (comportamento de hoje, 100% retrocompatível).
 * @param {(secretName: string) => Promise<string>} opts.getSecret
 * @param {string} opts.defaultSecretName — nome do secret usado quando a org não
 *   tem `billingConfig.secretName` próprio (caso do CCBMG hoje).
 */
async function getBillingProvider({ org, getSecret, defaultSecretName }) {
  const providerId = org?.billingProvider || 'asaas';
  const factory = providerFactories.get(providerId);
  if (!factory) {
    throw new Error(`getBillingProvider: provider "${providerId}" não registrado (registrados: ${[...providerFactories.keys()].join(', ')}).`);
  }

  const secretName = org?.billingConfig?.secretName || defaultSecretName;
  const apiKey = await getSecret(secretName);

  return factory({ apiKey });
}

module.exports = { getBillingProvider, registerBillingProvider, _unregisterBillingProviderForTests };
