// functions/test/fase36-multitenant-validation.test.js — Fase 3.6, critério
// de aceite "criar uma organização de teste e confirmar isolamento
// completo". As peças individuais (provisionOrganization, domains, branding,
// Rules) já têm cobertura própria em outros arquivos — este teste é a
// história ponta a ponta: provisiona uma organização nova do zero, configura
// domínio e confirma que o gatilho de branding roda, e SÓ DEPOIS testa que
// ela está completamente isolada de uma segunda organização com dados reais
// (moldada como o CCBMG: associados, financeiro, produtos, eventos).
const assert = require('assert');
const { seedPlatformAdmin, seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'f36_owner', email: 'f36_owner@teste.local', role: 'owner' });
  await db.collection('systemPlans').doc('f36_plan_starter').set({
    label: 'Starter', modules: { associados: true, eventos: true, classificados: true, financeiro: true },
  });

  // Organização "real" já existente, moldada como o CCBMG hoje — o que
  // importa isolar contra.
  await seedOrganization(db, { id: 'f36_ccbmg_like', nome: 'Clube Já Existente' });
  await seedUser(db, authInstance, { uid: 'f36_ccbmg_associado', cpf: '71111111101', orgId: 'f36_ccbmg_like', role: 'associado' });
  await db.collection('users').doc('f36_ccbmg_associado').collection('finance').doc('summary').set({ activeUntil: new Date(), balance: 0 });
  await db.collection('memberProducts').add({ orgId: 'f36_ccbmg_like', title: 'Produto do clube existente' });

  /* =======================================================================
     1) Provisionamento de verdade, do zero
     ======================================================================= */

  let provisionResult;
  await t('Fase 3.6 — organização de teste: provisionamento completo via provisionOrganization', async () => {
    provisionResult = await fns.provisionOrganization.run({
      orgId: 'f36_org_teste', nome: 'Organização de Teste Fase 3.6', planId: 'f36_plan_starter',
      master: { email: 'master.f36@teste.local', nome: 'Master de Teste' },
    }, ctx('f36_owner'));

    assert.strictEqual(provisionResult.status, 'completed');
    assert.ok(provisionResult.master.uid);
    assert.strictEqual(provisionResult.master.newlyCreated, true);
  });

  await t('organização de teste: módulos do plano foram aplicados (não herda nada da organização existente)', async () => {
    const org = (await db.collection('organizations').doc('f36_org_teste').get()).data();
    assert.deepStrictEqual(org.modules, { associados: true, eventos: true, classificados: true, financeiro: true });
    assert.strictEqual(org.billingProvider, 'asaas');
  });

  await t('organização de teste: Master de teste consegue se autenticar (role correta, orgId correto)', async () => {
    const masterDoc = await db.collection('users').doc(provisionResult.master.uid).get();
    assert.strictEqual(masterDoc.data().orgId, 'f36_org_teste');
    assert.strictEqual(masterDoc.data().role, 'Master');
    assert.strictEqual(masterDoc.data().primeiroAcesso, true);

    const authRecord = await authInstance.getUser(provisionResult.master.uid);
    assert.strictEqual(authRecord.email, 'master.f36@teste.local');
  });

  /* =======================================================================
     2) Domínio + branding — a organização de teste também consegue operar
     com a própria identidade, não só existir no Firestore.
     ======================================================================= */

  await t('organização de teste: domínio próprio pode ser registrado sem conflitar com o domínio do clube existente', async () => {
    const result = await fns.setOrganizationDomains.run({
      orgId: 'f36_org_teste', dominioPrincipal: 'clubedeteste-fase36.com.br',
    }, ctx('f36_owner'));
    assert.strictEqual(result.dominioPrincipal, 'clubedeteste-fase36.com.br');

    const domainDoc = await db.collection('domains').doc('clubedeteste-fase36.com.br').get();
    assert.strictEqual(domainDoc.data().orgId, 'f36_org_teste');
  });

  await t('organização de teste: branding é aplicado via Central de Configuração e o gatilho sincroniza a projeção pública', async () => {
    await db.collection('organizations').doc('f36_org_teste').update({
      nomeCurto: 'Teste F36',
      config: { logoUrl: 'https://x/logo-teste.png', corPrimaria: '#00ff00', corSecundaria: '#008800' },
    });

    // Simula o trigger onOrganizationWritten (é um trigger real, não uma
    // callable — chamado diretamente aqui, mesmo padrão de
    // organization-public-sync.test.js).
    const orgSnap = await db.collection('organizations').doc('f36_org_teste').get();
    await fns.onOrganizationWritten.run({ after: { exists: true, data: () => orgSnap.data() } }, { params: { orgId: 'f36_org_teste' } });

    const publicBranding = await db.collection('organizations').doc('f36_org_teste').collection('public').doc('branding').get();
    assert.strictEqual(publicBranding.data().nomeCurto, 'Teste F36');
    assert.strictEqual(publicBranding.data().corPrimaria, '#00ff00');
  });

  /* =======================================================================
     3) Isolamento completo contra a organização "real" (CCBMG-like)
     ======================================================================= */

  await seedUser(db, authInstance, { uid: 'f36_org_teste_admin', cpf: '71111111102', orgId: 'f36_org_teste', role: 'admin' });
  await seedUser(db, authInstance, { uid: 'f36_org_teste_associado', cpf: '71111111103', orgId: 'f36_org_teste', role: 'associado' });

  await t('CRÍTICO: admin da organização de teste NÃO consegue redefinir senha de associado do clube existente', async () => {
    await assertRejectsWithCode(
      () => fns.resetUserPassword.run({ targetUid: 'f36_ccbmg_associado', newPassword: 'abcdefgh12' }, ctx(provisionResult.master.uid)),
      'permission-denied'
    );
  });

  await t('CRÍTICO: Master da organização de teste NÃO consegue excluir associado do clube existente', async () => {
    await assertRejectsWithCode(
      () => fns.deleteAssociado.run({ uid: 'f36_ccbmg_associado' }, ctx(provisionResult.master.uid)),
      'permission-denied'
    );
    const stillThere = await db.collection('users').doc('f36_ccbmg_associado').get();
    assert.strictEqual(stillThere.exists, true, 'associado do clube existente não pode ter sido afetado');
  });

  await t('CRÍTICO: admin da organização de teste NÃO consegue criar cobrança pro uid do clube existente', async () => {
    await assertRejectsWithCode(
      () => fns.asaasCreatePayment.run({ uid: 'f36_ccbmg_associado', value: 30 }, ctx('f36_org_teste_admin')),
      'permission-denied'
    );
  });

  await t('sanidade: dados do clube existente (produto, financeiro) permanecem intocados por toda a criação/testes da organização nova', async () => {
    const produtosSnap = await db.collection('memberProducts').where('orgId', '==', 'f36_ccbmg_like').get();
    assert.strictEqual(produtosSnap.size, 1);
    assert.strictEqual(produtosSnap.docs[0].data().title, 'Produto do clube existente');

    const summary = await db.collection('users').doc('f36_ccbmg_associado').collection('finance').doc('summary').get();
    assert.strictEqual(summary.data().balance, 0);
  });

  await t('sanidade: a organização nova não vê os produtos do clube existente numa consulta filtrada por orgId', async () => {
    const produtosDaNova = await db.collection('memberProducts').where('orgId', '==', 'f36_org_teste').get();
    assert.strictEqual(produtosDaNova.size, 0, 'organização recém-criada não deveria herdar nem enxergar produto nenhum de outra organização');
  });
};
