// functions/test/outbound-messages.test.js — lib/prospecting... na verdade
// lib/outbound/messages.js testado direto contra o emulador (sem Claude
// nenhum envolvido): claim/lock, versões, transições de status.
const assert = require('assert');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { createOutboundMessagesService } = require('../lib/outbound/messages');

module.exports = async function run({ db, t }) {
  const serverTimestamp = () => new Date();
  const svc = createOutboundMessagesService({ db, serverTimestamp });

  /* =======================================================================
     claimForGeneration — geração inicial, regeneração, lock, estados terminais
     ======================================================================= */

  await t('claimForGeneration: leadId ausente rejeita invalid-argument', async () => {
    await assertRejectsWithCode(() => svc.claimForGeneration('', { channel: 'email' }), 'invalid-argument');
  });

  await t('claimForGeneration: channel inválido rejeita invalid-argument', async () => {
    await assertRejectsWithCode(() => svc.claimForGeneration('lead_x', { channel: 'fax' }), 'invalid-argument');
  });

  await t('claimForGeneration: geração inicial cria UM documento com status "generating"', async () => {
    const result = await svc.claimForGeneration('om_lead_1', { channel: 'email', createdBy: 'admin_1' });
    assert.strictEqual(result.isRegeneration, false);
    const snap = await db.collection('outboundMessages').doc('om_lead_1').get();
    assert.strictEqual(snap.data().status, 'generating');
    assert.strictEqual(snap.data().leadId, 'om_lead_1');
    assert.strictEqual(snap.data().createdBy, 'admin_1');
  });

  await t('claimForGeneration: segunda chamada enquanto já está "generating" rejeita already-exists (nunca 2 gerações simultâneas pro mesmo lead)', async () => {
    await assertRejectsWithCode(
      () => svc.claimForGeneration('om_lead_1', { channel: 'email' }),
      'already-exists'
    );
  });

  await t('claimForGeneration: lock "generating" muito antigo é tratado como travado (self-heal)', async () => {
    await db.collection('outboundMessages').doc('om_lead_1').update({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const result = await svc.claimForGeneration('om_lead_1', { channel: 'whatsapp' });
    assert.strictEqual(result.isRegeneration, true);
    assert.strictEqual(result.channel, 'whatsapp');
  });

  await t('claimForGeneration: regeneração NUNCA cria um segundo documento — continua sendo o mesmo leadId', async () => {
    const snaps = await db.collection('outboundMessages').where('leadId', '==', 'om_lead_1').get();
    assert.strictEqual(snaps.size, 1, 'deveria haver só 1 documento, mesmo depois de regenerar');
  });

  await t('claimForGeneration: abordagem "sent" não pode ser regenerada (failed-precondition)', async () => {
    await db.collection('outboundMessages').doc('om_lead_1').update({ status: 'sent' });
    await assertRejectsWithCode(
      () => svc.claimForGeneration('om_lead_1', { channel: 'email' }),
      'failed-precondition'
    );
  });

  /* =======================================================================
     recordVersion — histórico append-only + denormalização + contadores
     ======================================================================= */

  await t('recordVersion (ai_generated): cria versão, atualiza doc principal e incrementa contadores', async () => {
    await svc.claimForGeneration('om_lead_2', { channel: 'email', createdBy: 'admin_1' });
    const { versionId, status } = await svc.recordVersion('om_lead_2', {
      source: 'ai_generated', trigger: 'initial',
      subject: 'Assunto teste', message: 'Mensagem gerada pela IA', cta: 'Podemos conversar?',
      personalizationSummary: 'Resumo', motivos: ['Segmento compatível'],
      evidence: [{ url: 'https://x.com', informacaoExtraida: 'fato' }],
      researchPerformed: false, usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.002, searchesPerformed: 0,
      createdBy: 'admin_1',
    });
    assert.strictEqual(status, 'ready_for_review');
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.status, 'ready_for_review');
    assert.strictEqual(doc.message, 'Mensagem gerada pela IA');
    assert.strictEqual(doc.currentVersionId, versionId);
    assert.strictEqual(doc.generationCount, 1);
    assert.strictEqual(doc.totalCostUsd, 0.002);

    const versionSnap = await db.collection('outboundMessages').doc('om_lead_2').collection('versions').doc(versionId).get();
    assert.strictEqual(versionSnap.data().source, 'ai_generated');
    assert.strictEqual(versionSnap.data().trigger, 'initial');
  });

  await t('recordVersion: regeneração soma ao generationCount/totalCostUsd e preserva a versão anterior no histórico', async () => {
    await svc.claimForGeneration('om_lead_2', { channel: 'email' });
    await svc.recordVersion('om_lead_2', {
      source: 'ai_generated', trigger: 'regenerate',
      message: 'Segunda versão gerada', evidence: [], costUsd: 0.003, searchesPerformed: 1,
    });
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.generationCount, 2);
    assert.strictEqual(Math.round(doc.totalCostUsd * 1000), 5); // 0.002 + 0.003
    assert.strictEqual(doc.message, 'Segunda versão gerada');

    const versions = await db.collection('outboundMessages').doc('om_lead_2').collection('versions').get();
    assert.strictEqual(versions.size, 2, 'a versão anterior nunca é apagada — histórico completo');
  });

  await t('recordVersion (human_edited): status vira "edited", registra editedBy/editedAt', async () => {
    await svc.recordVersion('om_lead_2', {
      source: 'human_edited', trigger: 'edit',
      message: 'Mensagem editada pelo comercial', evidence: [],
      createdBy: 'comercial_1',
    });
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.status, 'edited');
    assert.strictEqual(doc.editedBy, 'comercial_1');
    assert.ok(doc.editedAt);
    assert.strictEqual(doc.message, 'Mensagem editada pelo comercial');
  });

  /* =======================================================================
     markFailed
     ======================================================================= */

  await t('markFailed: registra status "failed" com a mensagem de erro', async () => {
    await svc.claimForGeneration('om_lead_3', { channel: 'email' });
    await svc.markFailed('om_lead_3', { error: 'Claude API: rate_limit_error' });
    const doc = (await db.collection('outboundMessages').doc('om_lead_3').get()).data();
    assert.strictEqual(doc.status, 'failed');
    assert.match(doc.error, /rate_limit_error/);
  });

  /* =======================================================================
     setDecision — aprovar/rejeitar
     ======================================================================= */

  await t('setDecision: abordagem inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(() => svc.setDecision('lead_fantasma', 'approved', {}), 'not-found');
  });

  await t('setDecision: decision fora do enum rejeita invalid-argument', async () => {
    await assertRejectsWithCode(() => svc.setDecision('om_lead_2', 'maybe', {}), 'invalid-argument');
  });

  await t('setDecision: aprova uma abordagem "edited"', async () => {
    await svc.setDecision('om_lead_2', 'approved', { reviewedBy: 'comercial_1' });
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.status, 'approved');
    assert.strictEqual(doc.reviewedBy, 'comercial_1');
    assert.ok(doc.approvedAt);
  });

  await t('setDecision: abordagem "generating" (sem conteúdo ainda) não pode ser aprovada', async () => {
    await svc.claimForGeneration('om_lead_4', { channel: 'email' });
    await assertRejectsWithCode(() => svc.setDecision('om_lead_4', 'approved', {}), 'failed-precondition');
  });

  /* =======================================================================
     markSent / markResponded
     ======================================================================= */

  await t('markSent: só a partir de "approved" ou "edited" — "generating" é rejeitado', async () => {
    await assertRejectsWithCode(() => svc.markSent('om_lead_4', {}), 'failed-precondition');
  });

  await t('markSent: marca abordagem aprovada como enviada MANUALMENTE (nunca automático)', async () => {
    await svc.markSent('om_lead_2', { sentBy: 'comercial_1' });
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.status, 'sent');
    assert.strictEqual(doc.sentBy, 'comercial_1');
    assert.ok(doc.sentAt);
  });

  await t('markResponded: só a partir de "sent"', async () => {
    await svc.markResponded('om_lead_2');
    const doc = (await db.collection('outboundMessages').doc('om_lead_2').get()).data();
    assert.strictEqual(doc.status, 'responded');
  });

  // Limpeza
  for (const id of ['om_lead_1', 'om_lead_2', 'om_lead_3', 'om_lead_4']) {
    const versions = await db.collection('outboundMessages').doc(id).collection('versions').get();
    await Promise.all(versions.docs.map((d) => d.ref.delete()));
    await db.collection('outboundMessages').doc(id).delete();
  }
};
