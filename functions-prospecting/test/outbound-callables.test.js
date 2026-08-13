// functions/test/outbound-callables.test.js — Cloud Functions do Agente de
// Outbound, através de `fns.X.run()` (mesmo padrão do resto da suíte).
//
// IMPORTANTE: `generateOutboundMessage`/`requestOutboundBatch` estão ligados
// ao ClaudeProvider DE VERDADE em index.js (Secret Manager real) — chamá-los
// com um caller autorizado disparia uma chamada real à Claude API. Este
// arquivo testa APENAS o que é seguro testar via a Cloud Function real:
// (a) a rejeição de autorização dessas duas (nunca chega a tocar o Claude,
// a checagem de papel acontece antes), e (b) o restante das callables
// (approve/reject/edit/markSent/markResponded/updateSalesContext), que NUNCA
// chamam o Claude — só lib/outbound/messages.js e lib/outbound/salesContext.js.
// O comportamento de geração de verdade é coberto em outbound-engine.test.js
// contra um aiProvider fake (lib/outbound/engine.js direto).
const assert = require('assert');
const { seedPlatformAdmin } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

async function seedOutboundMessage(db, id, overrides = {}) {
  await db.collection('outboundMessages').doc(id).set({
    leadId: id, channel: 'email', status: 'ready_for_review',
    subject: 'Assunto original', message: 'Mensagem original gerada pela IA', cta: 'CTA original',
    personalizationSummary: 'Resumo', motivos: ['Motivo A'],
    evidence: [{ url: 'https://x.com', titulo: 'Fonte', tipoFonte: 'site', informacaoExtraida: 'fato' }],
    researchPerformed: false, currentVersionId: null, generationCount: 1, totalCostUsd: 0.001, totalSearchesPerformed: 0,
    error: null, createdBy: 'admin_seed', createdAt: new Date(), updatedAt: new Date(),
    approvedAt: null, rejectedAt: null, editedAt: null, sentAt: null, respondedAt: null, reviewedBy: null,
    ...overrides,
  });
}

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'oc_admin_1', email: 'oc.admin@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'oc_operator_1', email: 'oc.operator@teste.local', role: 'operator' });

  /* =======================================================================
     Autorização — generateOutboundMessage/requestOutboundBatch: só a
     rejeição é testada aqui (a checagem de papel acontece ANTES de qualquer
     chamada ao Claude, então é seguro exercitar via a Cloud Function real).
     ======================================================================= */

  await t('generateOutboundMessage: operator é rejeitado com permission-denied (nunca chega a chamar o Claude)', async () => {
    await assertRejectsWithCode(
      () => fns.generateOutboundMessage.run({ leadId: 'qualquer' }, ctx('oc_operator_1')),
      'permission-denied'
    );
  });

  await t('generateOutboundMessage: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(
      () => fns.generateOutboundMessage.run({ leadId: 'qualquer' }, ctx(null)),
      'unauthenticated'
    );
  });

  await t('requestOutboundBatch: operator é rejeitado com permission-denied', async () => {
    await assertRejectsWithCode(
      () => fns.requestOutboundBatch.run({ leadIds: ['a', 'b'] }, ctx('oc_operator_1')),
      'permission-denied'
    );
  });

  /* =======================================================================
     approveOutboundMessage / rejectOutboundMessage — não tocam o Claude
     ======================================================================= */

  await t('approveOutboundMessage: operator é rejeitado', async () => {
    await assertRejectsWithCode(
      () => fns.approveOutboundMessage.run({ leadId: 'x' }, ctx('oc_operator_1')),
      'permission-denied'
    );
  });

  await t('approveOutboundMessage: abordagem inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(
      () => fns.approveOutboundMessage.run({ leadId: 'oc_lead_fantasma' }, ctx('oc_admin_1')),
      'not-found'
    );
  });

  await t('approveOutboundMessage: aprova abordagem pronta para revisão', async () => {
    await seedOutboundMessage(db, 'oc_lead_1');
    await fns.approveOutboundMessage.run({ leadId: 'oc_lead_1' }, ctx('oc_admin_1'));
    const doc = (await db.collection('outboundMessages').doc('oc_lead_1').get()).data();
    assert.strictEqual(doc.status, 'approved');
    assert.strictEqual(doc.reviewedBy, 'oc_admin_1');
  });

  await t('rejectOutboundMessage: rejeita abordagem pronta para revisão', async () => {
    await seedOutboundMessage(db, 'oc_lead_2');
    await fns.rejectOutboundMessage.run({ leadId: 'oc_lead_2' }, ctx('oc_admin_1'));
    const doc = (await db.collection('outboundMessages').doc('oc_lead_2').get()).data();
    assert.strictEqual(doc.status, 'rejected');
  });

  /* =======================================================================
     editOutboundMessage — preserva evidence/motivos/personalizationSummary
     ======================================================================= */

  await t('editOutboundMessage: message vazio rejeita invalid-argument', async () => {
    await seedOutboundMessage(db, 'oc_lead_3');
    await assertRejectsWithCode(
      () => fns.editOutboundMessage.run({ leadId: 'oc_lead_3', message: '   ' }, ctx('oc_admin_1')),
      'invalid-argument'
    );
  });

  await t('editOutboundMessage: edita subject/message/cta, PRESERVA evidence/motivos/personalizationSummary da IA, cria nova versão', async () => {
    await fns.editOutboundMessage.run({
      leadId: 'oc_lead_3', subject: 'Assunto editado pelo comercial', message: 'Mensagem editada pelo comercial',
    }, ctx('oc_admin_1'));

    const doc = (await db.collection('outboundMessages').doc('oc_lead_3').get()).data();
    assert.strictEqual(doc.status, 'edited');
    assert.strictEqual(doc.subject, 'Assunto editado pelo comercial');
    assert.strictEqual(doc.message, 'Mensagem editada pelo comercial');
    // Evidências e motivos são da geração original da IA — o comercial nunca as redigita.
    assert.deepStrictEqual(doc.motivos, ['Motivo A']);
    assert.strictEqual(doc.evidence[0].informacaoExtraida, 'fato');
    assert.strictEqual(doc.personalizationSummary, 'Resumo');

    const versions = await db.collection('outboundMessages').doc('oc_lead_3').collection('versions').get();
    assert.strictEqual(versions.size, 1);
    assert.strictEqual(versions.docs[0].data().source, 'human_edited');
  });

  /* =======================================================================
     markOutboundMessageSent / markOutboundMessageResponded
     ======================================================================= */

  await t('markOutboundMessageSent: abordagem "ready_for_review" (nunca aprovada/editada) é rejeitada', async () => {
    await seedOutboundMessage(db, 'oc_lead_4');
    await assertRejectsWithCode(
      () => fns.markOutboundMessageSent.run({ leadId: 'oc_lead_4' }, ctx('oc_admin_1')),
      'failed-precondition'
    );
  });

  await t('markOutboundMessageSent: marca abordagem editada como enviada manualmente', async () => {
    await fns.markOutboundMessageSent.run({ leadId: 'oc_lead_3' }, ctx('oc_admin_1'));
    const doc = (await db.collection('outboundMessages').doc('oc_lead_3').get()).data();
    assert.strictEqual(doc.status, 'sent');
    assert.strictEqual(doc.sentBy, 'oc_admin_1');
  });

  await t('markOutboundMessageResponded: só a partir de "sent"', async () => {
    await fns.markOutboundMessageResponded.run({ leadId: 'oc_lead_3' }, ctx('oc_admin_1'));
    const doc = (await db.collection('outboundMessages').doc('oc_lead_3').get()).data();
    assert.strictEqual(doc.status, 'responded');
  });

  /* =======================================================================
     updateSalesContext
     ======================================================================= */

  await t('updateSalesContext: administrator configura o contexto comercial', async () => {
    await fns.updateSalesContext.run({
      propostaValor: 'Gestão completa para clubes e associações, sem depender de planilha.',
      diferenciais: ['Suporte humano', 'Implantação rápida'],
    }, ctx('oc_admin_1'));
    const snap = await db.collection('systemConfig').doc('salesContext').get();
    assert.strictEqual(snap.data().propostaValor, 'Gestão completa para clubes e associações, sem depender de planilha.');
    assert.deepStrictEqual(snap.data().diferenciais, ['Suporte humano', 'Implantação rápida']);
  });

  // Limpeza
  for (const id of ['oc_lead_1', 'oc_lead_2', 'oc_lead_3', 'oc_lead_4']) {
    const versions = await db.collection('outboundMessages').doc(id).collection('versions').get();
    await Promise.all(versions.docs.map((d) => d.ref.delete()));
    await db.collection('outboundMessages').doc(id).delete();
  }
  await db.collection('systemConfig').doc('salesContext').delete();
};
