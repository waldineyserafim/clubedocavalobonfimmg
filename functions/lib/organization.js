// functions/lib/organization.js — resolução de organização, único ponto de verdade.
//
// Mecanismo genérico: nenhum orgId, nenhum nome de organização, nenhuma regra de
// negócio do CCBMG aparece aqui. O papel deste módulo é só: dado um uid, dizer a
// qual organização ele pertence; dado um orgId, buscar/validar o documento da
// organização. Toda Cloud Function deve resolver organização por aqui — nunca
// lendo `users/{uid}.orgId` ou `organizations/{orgId}` diretamente.

const functions = require('firebase-functions');

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {string} [opts.usersCollection="users"]
 * @param {string} [opts.organizationsCollection="organizations"]
 * @param {number} [opts.cacheTtlMs=60000] — cache em memória do processo (instância
 *   quente da Cloud Function); evita reler `organizations/{orgId}` em toda invocação
 *   sequencial na mesma instância. Não é cache entre instâncias/regiões.
 */
function createOrganizationResolver({
  db,
  usersCollection = 'users',
  organizationsCollection = 'organizations',
  cacheTtlMs = 60000,
} = {}) {
  if (!db) throw new Error('createOrganizationResolver: db é obrigatório.');

  const orgCache = new Map(); // orgId -> { data, at }

  /**
   * Resolve a organização de um usuário a partir do uid (Firebase Auth).
   * @param {string} uid
   * @returns {Promise<{orgId: string, userDoc: object}>}
   */
  async function resolveOrganization(uid) {
    if (!uid) {
      throw new functions.https.HttpsError('invalid-argument', 'resolveOrganization: uid é obrigatório.');
    }
    const snap = await db.collection(usersCollection).doc(uid).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', `Usuário ${uid} não encontrado.`);
    }
    const userDoc = snap.data();
    const orgId = userDoc.orgId;
    if (!orgId) {
      throw new functions.https.HttpsError('failed-precondition', `Usuário ${uid} sem organização associada (orgId ausente).`);
    }
    return { orgId, userDoc };
  }

  /**
   * Busca o documento de uma organização (com cache curto em memória).
   * @param {string} orgId
   * @returns {Promise<object|null>}
   */
  async function getOrganization(orgId) {
    if (!orgId) {
      throw new functions.https.HttpsError('invalid-argument', 'getOrganization: orgId é obrigatório.');
    }
    const cached = orgCache.get(orgId);
    if (cached && (Date.now() - cached.at) < cacheTtlMs) return cached.data;

    const snap = await db.collection(organizationsCollection).doc(orgId).get();
    const data = snap.exists ? { id: snap.id, ...snap.data() } : null;
    orgCache.set(orgId, { data, at: Date.now() });
    return data;
  }

  /** @returns {Promise<object>} lança 'not-found' se a organização não existir. */
  async function assertOrganizationExists(orgId) {
    const org = await getOrganization(orgId);
    if (!org) {
      throw new functions.https.HttpsError('not-found', `Organização "${orgId}" não existe.`);
    }
    return org;
  }

  /** @returns {Promise<object>} lança 'failed-precondition' se a organização existir mas estiver desativada. */
  async function assertOrganizationEnabled(orgId) {
    const org = await assertOrganizationExists(orgId);
    if (org.ativo === false) {
      throw new functions.https.HttpsError('failed-precondition', `Organização "${orgId}" está desativada.`);
    }
    return org;
  }

  /** Só para testes: limpa o cache em memória entre cenários. */
  function _resetCacheForTests() {
    orgCache.clear();
  }

  return {
    resolveOrganization,
    getOrganization,
    assertOrganizationExists,
    assertOrganizationEnabled,
    _resetCacheForTests,
  };
}

module.exports = { createOrganizationResolver };
