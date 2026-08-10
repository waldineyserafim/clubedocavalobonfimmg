// functions/lib/platform.js — resolução e autorização de identidade de PLATAFORMA
// (Fase 3.2 — equipe da Serafim Technologies, nunca uma organização).
//
// Espelha organization.js/authorization.js, mas para um plano de identidade
// deliberadamente separado: um doc em platformAdmins/{uid} nunca tem orgId —
// garantia de schema, não de convenção. Quem administra a plataforma nunca é
// resolvido via users/{uid}, e um Organization Master nunca é resolvido via
// platformAdmins/{uid} — os dois planos não se enxergam por acidente.

const functions = require('firebase-functions');

const PLATFORM_ROLES = ['operator', 'administrator', 'owner'];

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {string} [opts.platformAdminsCollection="platformAdmins"]
 */
function createPlatformResolver({ db, platformAdminsCollection = 'platformAdmins' } = {}) {
  if (!db) throw new Error('createPlatformResolver: db é obrigatório.');

  /**
   * Resolve a identidade de PLATAFORMA de um uid — nunca envolve orgId.
   * Lança 'failed-precondition' se a conta existir mas estiver desativada ou
   * com um papel fora do vocabulário (dado corrompido/manual).
   * @param {string} uid
   * @returns {Promise<{uid: string, role: string, adminDoc: object}>}
   */
  async function resolvePlatformAdmin(uid) {
    if (!uid) {
      throw new functions.https.HttpsError('invalid-argument', 'resolvePlatformAdmin: uid é obrigatório.');
    }
    const snap = await db.collection(platformAdminsCollection).doc(uid).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', `Uid ${uid} não é um administrador de plataforma.`);
    }
    const adminDoc = snap.data();
    if (adminDoc.ativo === false) {
      throw new functions.https.HttpsError('failed-precondition', `Administrador de plataforma ${uid} está desativado.`);
    }
    if (!PLATFORM_ROLES.includes(adminDoc.role)) {
      throw new functions.https.HttpsError('failed-precondition', `Administrador de plataforma ${uid} com papel inválido: "${adminDoc.role}".`);
    }
    return { uid, role: adminDoc.role, adminDoc };
  }

  return { resolvePlatformAdmin };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createPlatformResolver>} opts.platformResolver
 */
function createPlatformAuthorizationHelpers({ platformResolver } = {}) {
  if (!platformResolver) throw new Error('createPlatformAuthorizationHelpers: platformResolver é obrigatório.');

  /** @returns {string} uid — lança 'unauthenticated' se não houver sessão. */
  function requireAuthenticatedUser(context) {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    return context.auth.uid;
  }

  /** Qualquer papel de plataforma ativo (operator, administrator ou owner). Base das validações abaixo. */
  async function requirePlatformStaff(context) {
    const uid = requireAuthenticatedUser(context);
    return platformResolver.resolvePlatformAdmin(uid);
  }

  /** Igual a requirePlatformStaff, mas exige administrator ou owner (nunca operator — somente leitura). */
  async function requirePlatformAdministrator(context) {
    const admin = await requirePlatformStaff(context);
    if (!['administrator', 'owner'].includes(admin.role)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil administrator ou owner da plataforma.');
    }
    return admin;
  }

  /** Igual a requirePlatformStaff, mas exige owner. */
  async function requirePlatformOwner(context) {
    const admin = await requirePlatformStaff(context);
    if (admin.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil owner da plataforma.');
    }
    return admin;
  }

  return {
    requireAuthenticatedUser,
    requirePlatformStaff,
    requirePlatformAdministrator,
    requirePlatformOwner,
  };
}

module.exports = { PLATFORM_ROLES, createPlatformResolver, createPlatformAuthorizationHelpers };
