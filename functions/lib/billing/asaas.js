// functions/lib/billing/asaas.js — implementação concreta do Billing Provider para o Asaas.
//
// Toda a mecânica de chamar api.asaas.com mora aqui — extraída 1:1 do que estava
// espalhado em ~15 pontos de functions/index.js antes da Fase 2B, preservando
// exatamente os mesmos endpoints, payloads e tratamento de erro (mesma extração
// de mensagem `data.errors?.[0]?.description || 'HTTP '+status`).
//
// `notifications.*` é uma extensão FORA do contrato genérico do Billing Provider
// (nem toda gateway de cobrança tem o conceito de "canal de notificação por
// evento") — CCBMG usa isso hoje, então fica exposto aqui, mas index.js sabe
// que está usando uma capacidade específica do Asaas ao chamar.

const DEFAULT_BASE_URL = 'https://api.asaas.com/v3';

// Eventos padrão criados automaticamente pelo Asaas para cada cliente. SEND_LINHA_DIGITAVEL
// não aceita ativação de WhatsApp (confirmado via teste em Sandbox); Set para permitir
// fallback dinâmico caso o Asaas rejeite outro evento no futuro.
const WHATSAPP_UNSUPPORTED_EVENTS_DEFAULT = new Set(['SEND_LINHA_DIGITAVEL']);

function mapPaymentStatus(payment) {
  if (payment.deleted === true) return 'cancelado';
  switch (payment.status) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
      return 'pago';
    case 'OVERDUE':
      return 'atrasado';
    case 'PENDING':
      return 'em_aberto';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
      return 'estornado';
    default:
      return 'em_aberto';
  }
}

function normalizePayment(payment) {
  return {
    providerId: payment.id,
    status: mapPaymentStatus(payment),
    rawStatus: payment.status,
    value: payment.value,
    dueDate: payment.dueDate,
    invoiceUrl: payment.invoiceUrl || null,
    billingType: payment.billingType || null,
    invoiceNumber: payment.invoiceNumber || null,
    paymentDate: payment.paymentDate || payment.confirmedDate || payment.clientPaymentDate || null,
    externalReference: payment.externalReference || null,
    subscriptionId: payment.subscription || null,
    deleted: payment.deleted === true,
    raw: payment,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey — já resolvido (do Secret Manager) por quem chama; o provider não sabe de onde veio.
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl] — injetável para testes.
 */
function createAsaasBillingProvider({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('createAsaasBillingProvider: apiKey é obrigatória.');

  const headers = { access_token: apiKey, 'Content-Type': 'application/json' };

  async function request(path, { method = 'GET', body } = {}) {
    const resp = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      const message = data.errors?.[0]?.description || `HTTP ${resp.status}`;
      const err = new Error(message);
      err.status = resp.status;
      err.providerData = data;
      throw err;
    }
    return data;
  }

  // ---- Customers ----

  async function findCustomerByExternalReference(externalReference) {
    if (!externalReference) return null;
    const data = await request(`/customers?externalReference=${encodeURIComponent(externalReference)}`);
    return data.data && data.data.length ? data.data[0] : null;
  }

  async function findCustomerByDocument(cpfCnpj) {
    if (!cpfCnpj) return null;
    const data = await request(`/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}`);
    return data.data && data.data.length ? data.data[0] : null;
  }

  async function createCustomer({ name, cpfCnpj, mobilePhone, email, externalReference }) {
    const data = await request('/customers', {
      method: 'POST',
      body: { name, cpfCnpj, mobilePhone, email, externalReference },
    });
    return { providerId: data.id, raw: data };
  }

  /**
   * Busca por externalReference primeiro (idempotente e correto); se não achar e
   * `allowDocumentFallback` for true, tenta por CPF/CNPJ; senão cria. Mesma
   * prioridade que `findOrCreateAsaasCustomer` usava antes da Fase 2B.
   */
  async function findOrCreateCustomer({ name, cpfCnpj, mobilePhone, email, externalReference, allowDocumentFallback = true }) {
    if (externalReference) {
      const byRef = await findCustomerByExternalReference(externalReference);
      if (byRef) return { providerId: byRef.id, raw: byRef, action: 'found' };
    }
    if (allowDocumentFallback && cpfCnpj) {
      const byDoc = await findCustomerByDocument(cpfCnpj);
      if (byDoc) return { providerId: byDoc.id, raw: byDoc, action: 'found' };
    }
    const created = await createCustomer({ name, cpfCnpj, mobilePhone, email, externalReference });
    return { ...created, action: 'created' };
  }

  async function updateCustomer(customerId, updates) {
    const data = await request(`/customers/${customerId}`, { method: 'POST', body: updates });
    return { raw: data };
  }

  /**
   * Exclusão definitiva do cliente no provider (usado só por deleteAssociado).
   * Fase 2C: antes disso, deleteAssociado não tinha como excluir o cliente de
   * verdade — só fazia um updateCustomer({}) como no-op defensivo.
   */
  async function deleteCustomer(customerId) {
    const data = await request(`/customers/${customerId}`, { method: 'DELETE' });
    return { raw: data, deleted: data.deleted === true };
  }

  // ---- Subscriptions ----

  async function createSubscription({ customerId, billingType = 'UNDEFINED', value, nextDueDate, cycle, description, externalReference, interest, notificationEnabled = true }) {
    const data = await request('/subscriptions', {
      method: 'POST',
      body: { customer: customerId, billingType, value, nextDueDate, cycle, description, externalReference, interest, notificationEnabled },
    });
    return { providerId: data.id, raw: data };
  }

  async function getSubscription(subscriptionId) {
    return request(`/subscriptions/${subscriptionId}`);
  }

  /** status: 'ACTIVE' | 'INACTIVE' — pausa/reativa sem apagar (equivalente a "cancelSubscription" reversível). */
  async function updateSubscriptionStatus(subscriptionId, status) {
    const data = await request(`/subscriptions/${subscriptionId}`, { method: 'POST', body: { status } });
    return { raw: data };
  }

  /** Interface genérica: "cancelar" = pausar (reversível) — é o que toda a base de código fazia até aqui. */
  async function cancelSubscription(subscriptionId) {
    return updateSubscriptionStatus(subscriptionId, 'INACTIVE');
  }

  /** Exclusão definitiva (usado só por deleteAssociado) — distinta de cancelSubscription (pausa). */
  async function deleteSubscription(subscriptionId) {
    return request(`/subscriptions/${subscriptionId}`, { method: 'DELETE' });
  }

  // ---- Charges / Payments (cobrança avulsa) ----

  async function createCharge({ customerId, billingType = 'UNDEFINED', value, dueDate, description, externalReference }) {
    const data = await request('/payments', {
      method: 'POST',
      body: { customer: customerId, billingType, value, dueDate, description, externalReference },
    });
    return { providerId: data.id, raw: data };
  }

  // Alias — o mesmo primitivo do Asaas (POST /payments) serve tanto para "cobrança avulsa"
  // quanto para "pagamento" no vocabulário do contrato genérico do Billing Provider.
  const createPayment = createCharge;

  async function cancelCharge(paymentId) {
    const data = await request(`/payments/${paymentId}`, { method: 'DELETE' });
    return { raw: data, deleted: data.deleted === true };
  }

  async function getCharge(paymentId) {
    const data = await request(`/payments/${paymentId}`);
    return normalizePayment(data);
  }

  async function refundPayment(paymentId) {
    const data = await request(`/payments/${paymentId}/refund`, { method: 'POST' });
    return { raw: data };
  }

  async function receiveInCash(paymentId, { paymentDate, value }) {
    const data = await request(`/payments/${paymentId}/receiveInCash`, {
      method: 'POST',
      body: { paymentDate, value },
    });
    return { raw: data };
  }

  async function listCharges({ customerId, subscriptionId, status, limit, sort, order } = {}) {
    const params = new URLSearchParams();
    if (customerId) params.set('customer', customerId);
    if (subscriptionId) params.set('subscription', subscriptionId);
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    if (sort) params.set('sort', sort);
    if (order) params.set('order', order);
    const data = await request(`/payments?${params.toString()}`);
    return (data.data || []).map(normalizePayment);
  }

  async function listAllCustomers({ limit = 100 } = {}) {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await request(`/customers?limit=${limit}&offset=${offset}`);
      all.push(...(data.data || []));
      if (!data.hasMore) break;
      offset += limit;
    }
    return all;
  }

  // ---- Webhook ----

  function verifyWebhookToken(receivedToken, expectedToken) {
    return !!receivedToken && receivedToken === expectedToken;
  }

  /**
   * Confirma o pagamento diretamente na API (anti-fraude) e resolve o uid via
   * externalReference da assinatura — mesma lógica de asaasWebhook antes da Fase 2B.
   * @returns {Promise<{confirmed: boolean, payment?: object, subscriptionExternalReference?: string}>}
   */
  async function processWebhook({ event, payment }) {
    if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event) || !payment?.id) {
      return { confirmed: false, reason: 'evento ignorado' };
    }

    const verified = await getCharge(payment.id);
    if (!['pago'].includes(verified.status)) {
      return { confirmed: false, reason: 'pagamento não confirmado na API' };
    }

    let subscriptionExternalReference = null;
    if (payment.subscription) {
      const sub = await getSubscription(payment.subscription);
      subscriptionExternalReference = sub.externalReference || null;
    }

    return { confirmed: true, payment: verified, subscriptionExternalReference };
  }

  // ---- Sincronização ----

  /** Espelha o que syncOneAssociado lia da API antes da Fase 2B — sem tocar Firestore. */
  async function synchronize({ customerId, subscriptionId }) {
    const subscription = subscriptionId ? await getSubscription(subscriptionId) : null;
    const recentPayments = subscriptionId
      ? await listCharges({ subscriptionId, limit: 10, sort: 'dueDate', order: 'desc' })
      : [];
    const notifications = customerId ? await notificationsList(customerId) : [];
    return { subscription, recentPayments, notifications };
  }

  async function healthCheck() {
    try {
      await request('/customers?limit=1');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---- Notificações (extensão específica do Asaas — fora do contrato genérico) ----

  async function notificationsList(customerId) {
    const data = await request(`/customers/${customerId}/notifications`);
    return data.data || [];
  }

  /**
   * Aplica o padrão institucional (WhatsApp + SMS ativos; e-mail e ligação
   * desativados). PUT /notifications/batch é atômico — se 1 notificação for
   * rejeitada, o lote inteiro falha — por isso o fallback reenvia sem o campo
   * problemático em vez de abortar. Mesma lógica de syncCustomerNotifications
   * antes da Fase 2B.
   */
  async function notificationsSync(customerId, { unsupportedEvents = WHATSAPP_UNSUPPORTED_EVENTS_DEFAULT } = {}) {
    const notifications = await notificationsList(customerId);
    const byId = new Map(notifications.map((n) => [n.id, n]));
    const unsupported = new Set(unsupportedEvents);

    const buildChanged = () => notifications.reduce((acc, notif) => {
      const desired = {
        enabled: true,
        whatsappEnabledForCustomer: !unsupported.has(notif.event),
        smsEnabledForCustomer: true,
        emailEnabledForCustomer: false,
        phoneCallEnabledForCustomer: false,
      };
      const isDifferent = Object.entries(desired).some(([k, v]) => notif[k] !== v);
      if (isDifferent) acc.push({ id: notif.id, ...desired });
      return acc;
    }, []);

    for (let attempt = 0; attempt <= notifications.length; attempt++) {
      const changed = buildChanged();
      if (!changed.length) return { total: notifications.length, changed: 0 };

      try {
        await request('/notifications/batch', { method: 'PUT', body: { customer: customerId, notifications: changed } });
        return { total: notifications.length, changed: changed.length };
      } catch (err) {
        const m = err.message.match(/notifica(?:ç|c)ão (not_\w+).*whatsapp/i);
        const badNotif = m && byId.get(m[1]);
        if (!badNotif || unsupported.has(badNotif.event)) throw err;
        unsupported.add(badNotif.event);
      }
    }
    throw new Error('Excedeu tentativas de ajuste do lote de notificações.');
  }

  /** Liga/desliga TODAS as notificações de um cliente de uma vez (usado na desativação de associado). */
  async function notificationsSetEnabled(customerId, enabled) {
    const notifications = await notificationsList(customerId);
    const changed = notifications.filter((n) => n.enabled !== enabled).map((n) => ({ id: n.id, enabled }));
    if (!changed.length) return { total: notifications.length, changed: 0 };
    await request('/notifications/batch', { method: 'PUT', body: { customer: customerId, notifications: changed } });
    return { total: notifications.length, changed: changed.length };
  }

  return {
    id: 'asaas',
    // Customers
    findCustomerByExternalReference,
    findCustomerByDocument,
    createCustomer,
    findOrCreateCustomer,
    updateCustomer,
    deleteCustomer,
    // Subscriptions
    createSubscription,
    getSubscription,
    updateSubscriptionStatus,
    cancelSubscription,
    deleteSubscription,
    // Charges / payments
    createCharge,
    createPayment,
    cancelCharge,
    getCharge,
    refundPayment,
    receiveInCash,
    listCharges,
    listAllCustomers,
    // Webhook
    verifyWebhookToken,
    processWebhook,
    // Sync / health
    synchronize,
    healthCheck,
    // Helpers puros
    mapPaymentStatus,
    normalizePayment,
    // Extensão específica do Asaas
    notifications: {
      list: notificationsList,
      sync: notificationsSync,
      setEnabled: notificationsSetEnabled,
    },
  };
}

module.exports = { createAsaasBillingProvider, mapPaymentStatus, normalizePayment };
