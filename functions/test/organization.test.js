// Testa lib/organization.js contra o emulador real.
const assert = require('assert');
const { createOrganizationResolver } = require('../lib/organization');
const { seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, t }) {
  await seedOrganization(db, { id: 'org_a', nome: 'Organização A' });
  await seedOrganization(db, { id: 'org_b', nome: 'Organização B', ativo: false });
  await seedUser(db, authInstance, { uid: 'orgtest_u1', cpf: '11111111101', orgId: 'org_a', role: 'associado' });

  const resolver = createOrganizationResolver({ db, cacheTtlMs: 0 });

  await t('resolveOrganization retorna orgId correto do doc do usuário', async () => {
    const { orgId, userDoc } = await resolver.resolveOrganization('orgtest_u1');
    assert.strictEqual(orgId, 'org_a');
    assert.strictEqual(userDoc.cpf, '11111111101');
  });

  await t('resolveOrganization lança not-found para uid inexistente', async () => {
    await assertRejectsWithCode(() => resolver.resolveOrganization('uid_que_nao_existe'), 'not-found');
  });

  await t('getOrganization retorna o documento certo', async () => {
    const org = await resolver.getOrganization('org_a');
    assert.strictEqual(org.nome, 'Organização A');
  });

  await t('getOrganization retorna null para organização inexistente', async () => {
    const org = await resolver.getOrganization('org_inexistente');
    assert.strictEqual(org, null);
  });

  await t('assertOrganizationExists lança not-found quando a org não existe', async () => {
    await assertRejectsWithCode(() => resolver.assertOrganizationExists('org_inexistente'), 'not-found');
  });

  await t('assertOrganizationEnabled lança failed-precondition para org desativada', async () => {
    await assertRejectsWithCode(() => resolver.assertOrganizationEnabled('org_b'), 'failed-precondition');
  });

  await t('assertOrganizationEnabled passa para org ativa', async () => {
    const org = await resolver.assertOrganizationEnabled('org_a');
    assert.strictEqual(org.id, 'org_a');
  });
};
