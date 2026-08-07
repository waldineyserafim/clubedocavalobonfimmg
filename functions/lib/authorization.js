// functions/lib/authorization.js — validações de autorização centralizadas.
//
// Elimina o padrão que a auditoria (Fase 2A) encontrou repetido em ~20 Cloud
// Functions: cada uma lia `users/{context.auth.uid}` e checava role na mão,
// sem NUNCA comparar organização do chamador com a do alvo — é o gap de maior
// severidade da auditoria (Admin SDK ignora Firestore Rules; sem isso, um
// admin de uma organização podia operar sobre uid de outra).
//
// Mecanismo genérico: recebe o resolvedor de organização e o mapRole já
// configurados por quem chama (index.js) — nenhuma regra do CCBMG mora aqui.

const functions = require('firebase-functions');

/**
 * @param {object} opts
 * @param {ReturnType<import('./organization').createOrganizationResolver>} opts.organizationResolver
 * @param {(raw: string) => string} opts.mapRole
 * @param {string} [opts.roleField="role"]
 */
function createAuthorizationHelpers({ organizationResolver, mapRole, roleField = 'role' } = {}) {
  if (!organizationResolver) throw new Error('createAuthorizationHelpers: organizationResolver é obrigatório.');
  if (!mapRole) throw new Error('createAuthorizationHelpers: mapRole é obrigatório.');

  /** @returns {string} uid — lança 'unauthenticated' se não houver sessão. */
  function requireAuthenticatedUser(context) {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    return context.auth.uid;
  }

  /**
   * Autenticado + pertence a uma organização. Base de todas as validações abaixo.
   * @returns {Promise<{uid: string, orgId: string, role: string, userDoc: object}>}
   */
  async function requireOrganizationMember(context) {
    const uid = requireAuthenticatedUser(context);
    const { orgId, userDoc } = await organizationResolver.resolveOrganization(uid);
    const role = mapRole(userDoc[roleField]);
    return { uid, orgId, role, userDoc };
  }

  /** Igual a requireOrganizationMember, mas exige role admin ou master (nunca adminView — somente leitura). */
  async function requireOrganizationAdmin(context) {
    const member = await requireOrganizationMember(context);
    if (!['admin', 'master'].includes(member.role)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }
    return member;
  }

  /** Igual a requireOrganizationMember, mas exige role master. */
  async function requireOrganizationMaster(context) {
    const member = await requireOrganizationMember(context);
    if (member.role !== 'master') {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil master.');
    }
    return member;
  }

  /**
   * Checagem de permissão genérica por tabela role→permissões, para casos que não
   * se encaixam em admin/master puro (ex.: adminView pode LER mas não ESCREVER).
   * @param {{role: string}} member
   * @param {string} permission
   * @param {Record<string, string[]>} permissionsByRole — definida por quem chama.
   */
  function requirePermission(member, permission, permissionsByRole) {
    const allowed = permissionsByRole[member.role] || [];
    if (!allowed.includes(permission)) {
      throw new functions.https.HttpsError('permission-denied', `Sem permissão para: ${permission}.`);
    }
  }

  /** Lança 'permission-denied' se as duas organizações não forem exatamente a mesma. */
  function assertSameOrganization(orgIdA, orgIdB, message) {
    if (!orgIdA || !orgIdB || orgIdA !== orgIdB) {
      throw new functions.https.HttpsError('permission-denied', message || 'Operação fora da sua organização.');
    }
  }

  /**
   * O achado central da Fase 2A: toda function que recebe um uid/targetUid de
   * payload (não de context.auth) precisa confirmar que esse alvo pertence à
   * MESMA organização de quem está chamando, antes de ler/escrever qualquer
   * coisa sobre ele.
   * @param {{orgId: string}} callerMember — já resolvido via requireOrganizationMember/Admin/Master.
   * @param {string} targetUid
   * @returns {Promise<{orgId: string, userDoc: object}>} organização/documento do alvo, já validados.
   */
  async function assertCallerCanManageTarget(callerMember, targetUid) {
    if (!targetUid) {
      throw new functions.https.HttpsError('invalid-argument', 'Usuário alvo não informado.');
    }
    const target = await organizationResolver.resolveOrganization(targetUid);
    assertSameOrganization(callerMember.orgId, target.orgId, 'Não é possível operar em um usuário de outra organização.');
    return target;
  }

  return {
    requireAuthenticatedUser,
    requireOrganizationMember,
    requireOrganizationAdmin,
    requireOrganizationMaster,
    requirePermission,
    assertSameOrganization,
    assertCallerCanManageTarget,
  };
}

module.exports = { createAuthorizationHelpers };
