// Testa as Cloud Functions REAIS (via .run(data, context), sem deploy) para o
// achado central da auditoria: admin/master de uma organização não pode agir
// sobre uid de outra. Testa só o caminho BLOQUEADO — ele retorna antes de
// qualquer chamada ao Secret Manager/Asaas (a checagem de autorização vem
// primeiro em toda function), então é seguro rodar sem tocar produção. O
// caminho de sucesso (que precisaria de credenciais reais do Asaas) é coberto
// pelos testes de lib/ com mocks (organization.test.js, authorization.test.js,
// billing-asaas.test.js).
const assert = require('assert');
const { seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  await seedOrganization(db, { id: 'ct_org_a', nome: 'Org A' });
  await seedOrganization(db, { id: 'ct_org_b', nome: 'Org B' });

  await seedUser(db, authInstance, { uid: 'ct_admin_a', cpf: '31111111101', orgId: 'ct_org_a', role: 'Admin' });
  await seedUser(db, authInstance, { uid: 'ct_master_a', cpf: '31111111102', orgId: 'ct_org_a', role: 'Master' });
  await seedUser(db, authInstance, { uid: 'ct_associado_a', cpf: '31111111103', orgId: 'ct_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'ct_user_b', cpf: '31111111104', orgId: 'ct_org_b', role: 'associado', extra: { asaasId: 'cus_should_not_be_touched' } });

  const ctx = (uid) => ({ auth: { uid } });

  await t('asaasCreatePayment: admin da org A NÃO consegue criar cobrança para uid da org B', async () => {
    await assertRejectsWithCode(
      () => fns.asaasCreatePayment.run({ uid: 'ct_user_b', value: 30 }, ctx('ct_admin_a')),
      'permission-denied'
    );
  });

  await t('asaasCancelPayment: admin da org A NÃO consegue cancelar cobrança de uid da org B', async () => {
    await assertRejectsWithCode(
      () => fns.asaasCancelPayment.run({ uid: 'ct_user_b', asaasPaymentId: 'pay_x' }, ctx('ct_admin_a')),
      'permission-denied'
    );
  });

  await t('asaasSyncAssociado: admin da org A NÃO consegue sincronizar uid da org B', async () => {
    await assertRejectsWithCode(
      () => fns.asaasSyncAssociado.run({ uid: 'ct_user_b' }, ctx('ct_admin_a')),
      'permission-denied'
    );
  });

  await t('resetUserPassword: master da org A NÃO consegue redefinir senha de uid da org B', async () => {
    await assertRejectsWithCode(
      () => fns.resetUserPassword.run({ targetUid: 'ct_user_b', newPassword: 'abcdefgh12' }, ctx('ct_master_a')),
      'permission-denied'
    );
  });

  await t('deleteAssociado: master da org A NÃO consegue excluir uid da org B', async () => {
    await assertRejectsWithCode(
      () => fns.deleteAssociado.run({ uid: 'ct_user_b' }, ctx('ct_master_a')),
      'permission-denied'
    );
  });

  await t('asaasCreatePayment: associado (não-admin) da org A é bloqueado antes mesmo da checagem de org', async () => {
    await assertRejectsWithCode(
      () => fns.asaasCreatePayment.run({ uid: 'ct_associado_a', value: 30 }, ctx('ct_associado_a')),
      'permission-denied'
    );
  });

  await t('resetUserPassword: admin comum (não-master) da org A é bloqueado', async () => {
    await assertRejectsWithCode(
      () => fns.resetUserPassword.run({ targetUid: 'ct_associado_a', newPassword: 'abcdefgh12' }, ctx('ct_admin_a')),
      'permission-denied'
    );
  });

  await t('confirmEventCheckin: membro da org A é bloqueado ao tentar confirmar registro da org B', async () => {
    const regRef = await db.collection('eventRegistrations').add({
      orgId: 'ct_org_b', token: 'tok_org_b_test', status: 'ativo', nome: 'Fulano B', eventoTitulo: 'Evento B',
    });
    await assertRejectsWithCode(
      () => fns.confirmEventCheckin.run({ token: 'tok_org_b_test' }, ctx('ct_admin_a')),
      'permission-denied'
    );
    await regRef.delete();
  });

  await t('confirmEventCheckin: associado comum (Fase 3.6 — não é mais staff-only por acidente) é bloqueado mesmo na própria org', async () => {
    const regRef = await db.collection('eventRegistrations').add({
      orgId: 'ct_org_a', token: 'tok_org_a_associado_test', status: 'ativo', nome: 'Fulano A', eventoTitulo: 'Evento A',
    });
    await assertRejectsWithCode(
      () => fns.confirmEventCheckin.run({ token: 'tok_org_a_associado_test' }, ctx('ct_associado_a')),
      'permission-denied'
    );
    await regRef.delete();
  });

  await t('confirmEventCheckin: admin da própria org CONTINUA conseguindo confirmar — fluxo real permanece funcionando', async () => {
    const regRef = await db.collection('eventRegistrations').add({
      orgId: 'ct_org_a', token: 'tok_org_a_admin_test', status: 'ativo', nome: 'Fulano A', eventoTitulo: 'Evento A',
    });
    const result = await fns.confirmEventCheckin.run({ token: 'tok_org_a_admin_test' }, ctx('ct_admin_a'));
    assert.strictEqual(result.result, 'confirmed');
    await regRef.delete();
  });

  // Confirma que o uid "vítima" da org B não foi tocado por nenhuma das tentativas acima.
  await t('sanidade: usuário da org B permanece intocado após todas as tentativas cross-tenant', async () => {
    const snap = await db.collection('users').doc('ct_user_b').get();
    assert.strictEqual(snap.data().asaasId, 'cus_should_not_be_touched');
    assert.strictEqual(snap.data().ativo, true);
  });
};
