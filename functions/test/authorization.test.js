// Testa lib/authorization.js — o achado central da auditoria (Fase 2A): admin
// de uma organização não pode operar sobre uid de outra.
const assert = require('assert');
const { createOrganizationResolver } = require('../lib/organization');
const { createAuthorizationHelpers } = require('../lib/authorization');
const { createRoleResolver } = require('../lib/roles');
const { seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

const mapRole = createRoleResolver(
  [
    ['master', (n) => n.includes('master')],
    ['adminView', (n) => n.includes('admin') && n.includes('view')],
    ['admin', (n) => n.includes('admin')],
    ['operador', (n) => n.includes('operador')],
    ['participanteLeilao', (n) => n.includes('participante')],
  ],
  'associado'
);

module.exports = async function run({ db, authInstance, t }) {
  await seedOrganization(db, { id: 'authz_org_a', nome: 'Org A' });
  await seedOrganization(db, { id: 'authz_org_b', nome: 'Org B' });

  await seedUser(db, authInstance, { uid: 'authz_admin_a', cpf: '21111111101', orgId: 'authz_org_a', role: 'Admin' });
  await seedUser(db, authInstance, { uid: 'authz_master_a', cpf: '21111111102', orgId: 'authz_org_a', role: 'Master' });
  await seedUser(db, authInstance, { uid: 'authz_associado_a', cpf: '21111111103', orgId: 'authz_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'authz_adminview_a', cpf: '21111111104', orgId: 'authz_org_a', role: 'Admin View' });
  await seedUser(db, authInstance, { uid: 'authz_operador_a', cpf: '21111111106', orgId: 'authz_org_a', role: 'Operador' });
  await seedUser(db, authInstance, { uid: 'authz_participante_a', cpf: '21111111107', orgId: 'authz_org_a', role: 'Participante Leilão' });
  await seedUser(db, authInstance, { uid: 'authz_user_b', cpf: '21111111105', orgId: 'authz_org_b', role: 'associado' });

  const organizationResolver = createOrganizationResolver({ db, cacheTtlMs: 0 });
  const auth = createAuthorizationHelpers({ organizationResolver, mapRole });

  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await t('requireAuthenticatedUser lança unauthenticated sem context.auth', async () => {
    await assertRejectsWithCode(async () => auth.requireAuthenticatedUser(ctx(null)), 'unauthenticated');
  });

  await t('requireOrganizationMember resolve uid, orgId e role corretos', async () => {
    const member = await auth.requireOrganizationMember(ctx('authz_admin_a'));
    assert.strictEqual(member.orgId, 'authz_org_a');
    assert.strictEqual(member.role, 'admin');
  });

  await t('requireOrganizationAdmin passa para admin', async () => {
    const member = await auth.requireOrganizationAdmin(ctx('authz_admin_a'));
    assert.strictEqual(member.role, 'admin');
  });

  await t('requireOrganizationAdmin passa para master', async () => {
    const member = await auth.requireOrganizationAdmin(ctx('authz_master_a'));
    assert.strictEqual(member.role, 'master');
  });

  await t('requireOrganizationAdmin BLOQUEIA associado', async () => {
    await assertRejectsWithCode(() => auth.requireOrganizationAdmin(ctx('authz_associado_a')), 'permission-denied');
  });

  await t('requireOrganizationAdmin BLOQUEIA adminView (somente leitura, não é admin pleno)', async () => {
    await assertRejectsWithCode(() => auth.requireOrganizationAdmin(ctx('authz_adminview_a')), 'permission-denied');
  });

  await t('requireOrganizationMaster BLOQUEIA admin comum', async () => {
    await assertRejectsWithCode(() => auth.requireOrganizationMaster(ctx('authz_admin_a')), 'permission-denied');
  });

  await t('requireOrganizationAdmin BLOQUEIA operador', async () => {
    await assertRejectsWithCode(() => auth.requireOrganizationAdmin(ctx('authz_operador_a')), 'permission-denied');
  });

  await t('requireOrganizationAdmin BLOQUEIA participanteLeilao', async () => {
    await assertRejectsWithCode(() => auth.requireOrganizationAdmin(ctx('authz_participante_a')), 'permission-denied');
  });

  await t('requireOrganizationMember resolve operador e participanteLeilao corretamente', async () => {
    const operador = await auth.requireOrganizationMember(ctx('authz_operador_a'));
    assert.strictEqual(operador.role, 'operador');
    const participante = await auth.requireOrganizationMember(ctx('authz_participante_a'));
    assert.strictEqual(participante.role, 'participanteLeilao');
  });

  await t('assertSameOrganization passa quando as organizações batem', async () => {
    assert.doesNotThrow(() => auth.assertSameOrganization('authz_org_a', 'authz_org_a'));
  });

  await t('assertSameOrganization BLOQUEIA organizações diferentes', async () => {
    await assertRejectsWithCode(async () => auth.assertSameOrganization('authz_org_a', 'authz_org_b'), 'permission-denied');
  });

  await t('CRÍTICO: assertCallerCanManageTarget BLOQUEIA admin da org A operando sobre uid da org B', async () => {
    const callerA = await auth.requireOrganizationAdmin(ctx('authz_admin_a'));
    await assertRejectsWithCode(
      () => auth.assertCallerCanManageTarget(callerA, 'authz_user_b'),
      'permission-denied',
      'admin da org A conseguiu "gerenciar" um uid da org B — isso é exatamente o gap G2/asaasCreatePayment da auditoria'
    );
  });

  await t('assertCallerCanManageTarget PERMITE admin operando sobre uid da própria organização', async () => {
    const callerA = await auth.requireOrganizationAdmin(ctx('authz_admin_a'));
    const target = await auth.assertCallerCanManageTarget(callerA, 'authz_associado_a');
    assert.strictEqual(target.orgId, 'authz_org_a');
  });

  await t('assertCallerCanManageTarget lança invalid-argument sem uid alvo', async () => {
    const callerA = await auth.requireOrganizationAdmin(ctx('authz_admin_a'));
    await assertRejectsWithCode(() => auth.assertCallerCanManageTarget(callerA, undefined), 'invalid-argument');
  });
};
