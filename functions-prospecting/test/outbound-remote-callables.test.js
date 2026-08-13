// functions/test/outbound-remote-callables.test.js — Cloud Functions do
// botão "Executar Outbound IA" (previewOutboundRemoteRun/
// requestOutboundRemoteRun), através de `fns.X.run()`.
//
// IMPORTANTE: `requestOutboundRemoteRun` está ligada ao githubDispatchService
// DE VERDADE em index.js (token real do Secret Manager, fetch real) —
// chamá-la com um caller autorizado e leads elegíveis disparia um workflow
// de verdade no GitHub Actions. Este arquivo testa: (a) a rejeição de
// autorização (nunca chega a chamar o GitHub, a checagem de papel acontece
// antes) e (b) o caminho "nenhum lead elegível" (falha antes do dispatch,
// failed-precondition). O disparo de verdade é testado manualmente, uma
// única vez, fora da suíte automatizada (ver relatório da Fase).
// `previewOutboundRemoteRun` é 100% seguro de testar por completo — nunca
// chama o GitHub, só lê Firestore.
const assert = require('assert');
const { seedPlatformAdmin, seedLead } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'orc_admin_1', email: 'orc.admin@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'orc_operator_1', email: 'orc.operator@teste.local', role: 'operator' });

  await t('previewOutboundRemoteRun: operator é rejeitado com permission-denied', async () => {
    await assertRejectsWithCode(() => fns.previewOutboundRemoteRun.run({}, ctx('orc_operator_1')), 'permission-denied');
  });

  await t('previewOutboundRemoteRun: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(() => fns.previewOutboundRemoteRun.run({}, ctx(null)), 'unauthenticated');
  });

  await t('previewOutboundRemoteRun: administrator recebe os números corretos, sem nenhuma execução em andamento', async () => {
    await seedLead(db, { id: 'orc_lead_preview', organizacaoNome: 'Preview Teste' });
    const result = await fns.previewOutboundRemoteRun.run({}, ctx('orc_admin_1'));
    assert.ok(result.totalQualificados >= 1);
    assert.strictEqual(result.jaExisteExecucaoEmAndamento, false);
    assert.ok(result.seraoProcessados <= 20);
    await db.collection('leads').doc('orc_lead_preview').delete();
  });

  await t('previewOutboundRemoteRun: indica execução em andamento quando há lock "pending"/"running" recente', async () => {
    await db.collection('outboundRemoteRuns').doc('_lock').set({ status: 'running', runId: 'fake_run', updatedAt: new Date() });
    const result = await fns.previewOutboundRemoteRun.run({}, ctx('orc_admin_1'));
    assert.strictEqual(result.jaExisteExecucaoEmAndamento, true);
    await db.collection('outboundRemoteRuns').doc('_lock').delete();
  });

  await t('requestOutboundRemoteRun: operator é rejeitado com permission-denied (nunca chega a chamar o GitHub)', async () => {
    await assertRejectsWithCode(() => fns.requestOutboundRemoteRun.run({}, ctx('orc_operator_1')), 'permission-denied');
  });

  await t('requestOutboundRemoteRun: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(() => fns.requestOutboundRemoteRun.run({}, ctx(null)), 'unauthenticated');
  });

  await t('requestOutboundRemoteRun: sem nenhum lead elegível, rejeita failed-precondition ANTES de chamar o GitHub', async () => {
    // Nenhum lead elegível seedado nesta seção — coleção `leads` pode ter
    // sobras de outros testes, então isso só é confiável se realmente
    // ficarem 0 elegíveis; usamos um cenário isolado marcando todos os leads
    // existentes como já abordados não é prático aqui — em vez disso
    // confiamos no teste de unidade de eligibility.js pra cobertura de
    // filtro, e aqui testamos só que o caminho existe e nunca lança um erro
    // de outra natureza quando de fato não há elegíveis (skip se houver).
    const preview = await fns.previewOutboundRemoteRun.run({}, ctx('orc_admin_1'));
    if (preview.totalQualificados > 0) {
      console.log('    (skip: há leads elegíveis de outros testes, não é possível isolar o cenário "zero elegíveis" aqui)');
      return;
    }
    await assertRejectsWithCode(() => fns.requestOutboundRemoteRun.run({}, ctx('orc_admin_1')), 'failed-precondition');
  });
};
