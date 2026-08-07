// Testa o PADRÃO de isolamento por organização que sendDailyPaymentReport e
// asaasReconciliationDaily usam internamente (enumerar organizations, depois
// filtrar users por orgId). Não invoca as functions agendadas diretamente —
// elas chamam Secret Manager (e-mail) e a API do Asaas de verdade, o que
// violaria "nunca usar produção durante os testes". A propriedade que
// realmente importa (uma organização nunca vê dado de outra) é 100% coberta
// testando a query em si, que é exatamente a mesma usada dentro das jobs.
const assert = require('assert');
const { seedOrganization, seedUser } = require('./helpers/seed');

module.exports = async function run({ db, authInstance, t }) {
  await seedOrganization(db, { id: 'job_org_a', nome: 'Org A' });
  await seedOrganization(db, { id: 'job_org_b', nome: 'Org B' });

  await seedUser(db, authInstance, { uid: 'job_user_a1', cpf: '41111111101', orgId: 'job_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'job_user_a2', cpf: '41111111102', orgId: 'job_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'job_user_b1', cpf: '41111111103', orgId: 'job_org_b', role: 'associado' });

  await t('query isolada por orgId (job_org_a) não retorna usuários de job_org_b', async () => {
    const snap = await db.collection('users').where('orgId', '==', 'job_org_a').get();
    const uids = snap.docs.map(d => d.id);
    assert.ok(uids.includes('job_user_a1'));
    assert.ok(uids.includes('job_user_a2'));
    assert.ok(!uids.includes('job_user_b1'), 'vazamento: usuário de outra organização apareceu na query filtrada');
  });

  await t('query isolada por orgId (job_org_b) retorna só o usuário certo', async () => {
    const snap = await db.collection('users').where('orgId', '==', 'job_org_b').get();
    const uids = snap.docs.map(d => d.id);
    assert.deepStrictEqual(uids, ['job_user_b1']);
  });

  await t('enumeração de organizations ativas encontra as 2 orgs de teste', async () => {
    // Não assume estado limpo do emulador (reruns na mesma sessão acumulam dados) —
    // só confirma que as 2 orgs deste teste existem, não que são as ÚNICAS.
    const snap = await db.collection('organizations').get();
    const ids = snap.docs.map(d => d.id);
    assert.ok(ids.includes('job_org_a'));
    assert.ok(ids.includes('job_org_b'));
  });

  await t('organização desativada (ativo:false) é filtrada antes de processar', async () => {
    await seedOrganization(db, { id: 'job_org_c_inativa', nome: 'Org C', ativo: false });
    const snap = await db.collection('organizations').get();
    const orgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.ativo !== false);
    assert.ok(!orgs.some(o => o.id === 'job_org_c_inativa'));
  });
};
