// functions/test/prospecting-campaigns.test.js — CRUD de campanhas via Cloud
// Functions (autorização + validação/defaults), mesmo padrão de leads.test.js
// e features.test.js.
const assert = require('assert');
const { seedPlatformAdmin } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'pc_admin_1', email: 'pc.admin@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'pc_operator_1', email: 'pc.operator@teste.local', role: 'operator' });

  /* =======================================================================
     Autorização — igual a leads: só administrator/owner, operator excluído.
     ======================================================================= */

  await t('createProspectingCampaign: operator é rejeitado com permission-denied', async () => {
    await assertRejectsWithCode(
      () => fns.createProspectingCampaign.run({ name: 'Campanha Teste' }, ctx('pc_operator_1')),
      'permission-denied'
    );
  });

  await t('createProspectingCampaign: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(
      () => fns.createProspectingCampaign.run({ name: 'Campanha Teste' }, ctx(null)),
      'unauthenticated'
    );
  });

  /* =======================================================================
     createProspectingCampaign — defaults da primeira versão (CLAUDE.md)
     ======================================================================= */

  await t('createProspectingCampaign: name vazio rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.createProspectingCampaign.run({ name: '  ' }, ctx('pc_admin_1')),
      'invalid-argument'
    );
  });

  let campaignId;
  await t('createProspectingCampaign: cria com defaults (status active, execution semanal/20 leads, createdBy = criador)', async () => {
    const result = await fns.createProspectingCampaign.run({
      name: 'Prospecção Clubes MG',
      icp: { segmento: ['clube', 'associacao'], caracteristicasObrigatorias: ['tem site ativo'] },
    }, ctx('pc_admin_1'));
    campaignId = result.id;
    const snap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    const c = snap.data();
    assert.strictEqual(c.status, 'active');
    assert.strictEqual(c.campaignStatus, 'idle');
    assert.strictEqual(c.createdBy, 'pc_admin_1');
    assert.strictEqual(c.execution.frequencia, 'weekly');
    assert.strictEqual(c.execution.maxLeadsPerRun, 20); // "até 20 leads qualificados" — meta, não garantia
    assert.strictEqual(c.qualification.scoreMinimo, 70);
    assert.deepStrictEqual(c.icp.segmento, ['clube', 'associacao']);
    assert.deepStrictEqual(c.icp.caracteristicasObrigatorias, ['tem site ativo']);
  });

  await t('createProspectingCampaign: execution fora dos limites é fixado (clamp), nunca rejeitado silenciosamente com valor absurdo', async () => {
    const result = await fns.createProspectingCampaign.run({
      name: 'Campanha com limites exagerados',
      execution: { maxLeadsPerRun: 99999, maxIterations: -5, timeoutSeconds: 999999 },
    }, ctx('pc_admin_1'));
    const snap = await db.collection('prospectingCampaigns').doc(result.id).get();
    const exec = snap.data().execution;
    assert.ok(exec.maxLeadsPerRun <= 100);
    assert.ok(exec.maxIterations >= 1);
    assert.ok(exec.timeoutSeconds <= 1740, 'timeout precisa ficar sob o teto da function do motor (30min)');
    await db.collection('prospectingCampaigns').doc(result.id).delete();
  });

  /* =======================================================================
     updateProspectingCampaign
     ======================================================================= */

  await t('updateProspectingCampaign: campanha inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(
      () => fns.updateProspectingCampaign.run({ id: 'campanha_fantasma', name: 'X' }, ctx('pc_admin_1')),
      'not-found'
    );
  });

  await t('updateProspectingCampaign: atualiza qualification.scoreMinimo', async () => {
    await fns.updateProspectingCampaign.run({ id: campaignId, qualification: { scoreMinimo: 85 } }, ctx('pc_admin_1'));
    const snap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(snap.data().qualification.scoreMinimo, 85);
  });

  /* =======================================================================
     setProspectingCampaignStatus / archiveProspectingCampaign
     ======================================================================= */

  await t('setProspectingCampaignStatus: pausa e reativa a campanha', async () => {
    await fns.setProspectingCampaignStatus.run({ id: campaignId, status: 'paused' }, ctx('pc_admin_1'));
    let snap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(snap.data().status, 'paused');

    await fns.setProspectingCampaignStatus.run({ id: campaignId, status: 'active' }, ctx('pc_admin_1'));
    snap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(snap.data().status, 'active');
  });

  await t('setProspectingCampaignStatus: status fora do enum ("archived" incluso) rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.setProspectingCampaignStatus.run({ id: campaignId, status: 'archived' }, ctx('pc_admin_1')),
      'invalid-argument'
    );
  });

  await t('archiveProspectingCampaign: arquiva (soft state, nunca hard delete)', async () => {
    await fns.archiveProspectingCampaign.run({ id: campaignId }, ctx('pc_admin_1'));
    const snap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(snap.data().status, 'archived');
    assert.ok(snap.exists);
  });

  // Limpeza
  await db.collection('prospectingCampaigns').doc(campaignId).delete();
};
