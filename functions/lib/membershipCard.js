// functions/lib/membershipCard.js — Carteirinha Digital do Associado.
//
// Mecanismo de PLATAFORMA (nenhuma regra do CCBMG mora aqui): qualquer
// organização tem exatamente o mesmo fluxo — token opaco por associado,
// validado sempre contra o estado ATUAL de `users/{uid}` +
// `users/{uid}/finance/summary`, nunca contra dado gravado no QR Code.
//
// Modelo de dados (reaproveita o padrão já usado por finance/summary —
// subcoleção do próprio usuário, dono+admin da org leem, só Cloud Function
// escreve):
//   users/{uid}/membershipCard/card   { token, tokenHash, orgId, createdAt, revokedAt }
//   membershipCardTokens/{tokenHash}  { uid, orgId, createdAt, revokedAt }
// O token cru só existe no doc do próprio usuário (pra ele poder redesenhar
// o QR sem chamar a function de novo); o índice reverso guarda só o hash
// como ID do documento — nunca lista, nunca expõe o token cru.
//
// Diferença deliberada do token de check-in de eventos (eventRegistrations):
// aquele é UUID de uso único (uma confirmação, depois vira histórico); este
// é de vida longa e é REVALIDADO do zero a cada leitura (nunca marca "usado").

const crypto = require('crypto');

function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Decide validade da carteirinha a partir do estado atual do associado —
 * nunca de nada armazenado no QR. `ativo:false` (desativação administrativa)
 * invalida na hora, mesmo com activeUntil no futuro; autocancelamento não
 * mexe em `ativo`, então continua válido até `activeUntil` vencer.
 * @param {{ativo?: boolean, activeUntil?: any, now?: Date}} params
 * @returns {{valid: boolean, reason: 'ativo'|'desativado'|'expirado'}}
 */
function computeCardStatus({ ativo, activeUntil, now } = {}) {
  const nowDate = now || new Date();

  if (ativo === false) {
    return { valid: false, reason: 'desativado' };
  }

  const until = activeUntil?.toDate ? activeUntil.toDate() : (activeUntil ? new Date(activeUntil) : null);
  if (!until || Number.isNaN(until.getTime()) || until.getTime() < nowDate.getTime()) {
    return { valid: false, reason: 'expirado' };
  }

  return { valid: true, reason: 'ativo' };
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 */
function createMembershipCardService({ db, serverTimestamp }) {
  if (!db) throw new Error('createMembershipCardService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createMembershipCardService: serverTimestamp é obrigatório.');

  const tokensCol = db.collection('membershipCardTokens');

  /**
   * Idempotente: devolve o token existente (se ainda não revogado) ou cria
   * um novo. Nunca chamado com uid/orgId vindos de payload — sempre do
   * caller autenticado (ver index.js).
   * @returns {Promise<{token: string, createdAt: any}>}
   */
  async function ensureToken(uid, orgId) {
    const cardRef = db.collection('users').doc(uid).collection('membershipCard').doc('card');
    const cardSnap = await cardRef.get();

    if (cardSnap.exists && !cardSnap.data().revokedAt) {
      const card = cardSnap.data();
      return { token: card.token, createdAt: card.createdAt };
    }

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const createdAt = serverTimestamp();

    const batch = db.batch();
    batch.set(cardRef, { token: rawToken, tokenHash, orgId, createdAt, revokedAt: null });
    batch.set(tokensCol.doc(tokenHash), { uid, orgId, createdAt, revokedAt: null });
    await batch.commit();

    return { token: rawToken, createdAt };
  }

  /**
   * Sempre recalcula a validade a partir do Firestore no momento da chamada
   * — o token só serve para localizar o associado, nunca para decidir status.
   * Payload de retorno é deliberadamente mínimo (LGPD): sem CPF/telefone/
   * e-mail/dado financeiro além da data de vigência já pública na carteirinha física.
   */
  async function verifyToken(rawToken) {
    const tokenHash = hashToken(rawToken);
    const idxSnap = await tokensCol.doc(tokenHash).get();

    if (!idxSnap.exists || idxSnap.data().revokedAt) {
      return { valid: false, reason: 'not_found' };
    }

    const { uid, orgId } = idxSnap.data();
    const [userSnap, summarySnap, brandingSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('finance').doc('summary').get(),
      db.collection('organizations').doc(orgId).collection('public').doc('branding').get(),
    ]);

    if (!userSnap.exists) {
      return { valid: false, reason: 'not_found' };
    }

    const user = userSnap.data();
    const summary = summarySnap.exists ? summarySnap.data() : {};
    const branding = brandingSnap.exists ? brandingSnap.data() : {};
    const now = new Date();

    const status = computeCardStatus({ ativo: user.ativo, activeUntil: summary.activeUntil, now });
    const activeUntilDate = summary.activeUntil?.toDate ? summary.activeUntil.toDate() : (summary.activeUntil ? new Date(summary.activeUntil) : null);

    return {
      valid: status.valid,
      reason: status.reason,
      uid,
      orgId,
      nome: user.nome || '',
      categoria: user.categoriaAssociado || null,
      fotoUrl: user.fotoUrl || null,
      activeUntil: activeUntilDate ? activeUntilDate.toISOString() : null,
      tenantNome: branding.nomeCurto || branding.nome || null,
      tenantLogoUrl: branding.logoUrl || null,
      verifiedAt: now.toISOString(),
    };
  }

  return { ensureToken, verifyToken };
}

module.exports = { createMembershipCardService, computeCardStatus, generateRawToken, hashToken };
