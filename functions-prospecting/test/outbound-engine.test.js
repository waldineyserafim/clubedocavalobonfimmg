// functions/test/outbound-engine.test.js — lib/outbound/engine.js testado
// DIRETO, com um aiProvider fake roteirizado (nunca toca a Claude API de
// verdade — "modo seguro de teste", CLAUDE.md "Teste Real"). leadsService/
// messagesService/salesContextService são os reais, contra o emulador.
const assert = require('assert');
const { seedLead } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { createOutboundMessagesService } = require('../lib/outbound/messages');
const { createSalesContextService } = require('../lib/outbound/salesContext');
const { createOutboundEngine } = require('../lib/outbound/engine');

function makeFakeProvider(scriptFn) {
  const calls = [];
  return {
    generateOutboundApproach: async (args) => {
      calls.push(args);
      const result = await scriptFn(args, calls.length);
      if (result instanceof Error) throw result;
      return {
        subject: '', message: '', cta: '', personalizationSummary: 'Resumo padrão', motivos: [],
        evidence: [], researchPerformed: false, usage: { inputTokens: 10, outputTokens: 10 },
        costUsd: 0.001, searchesPerformed: 0, stopReason: 'tool_use',
        ...result,
      };
    },
    calls,
  };
}

module.exports = async function run({ db, t }) {
  const serverTimestamp = () => new Date();
  const messagesService = createOutboundMessagesService({ db, serverTimestamp });
  const salesContextService = createSalesContextService({ db, serverTimestamp, collectionName: 'systemConfigEngineTest' });

  function buildEngine(scriptFn) {
    return createOutboundEngine({
      db, serverTimestamp, messagesService, salesContextService,
      aiProvider: makeFakeProvider(scriptFn),
    });
  }

  async function cleanupOutbound(leadId) {
    const versions = await db.collection('outboundMessages').doc(leadId).collection('versions').get();
    await Promise.all(versions.docs.map((d) => d.ref.delete()));
    await db.collection('outboundMessages').doc(leadId).delete();
  }

  /* =======================================================================
     generateForLead — casos básicos
     ======================================================================= */

  await t('generateForLead: lead inexistente rejeita not-found', async () => {
    const engine = buildEngine(() => ({ message: 'oi' }));
    await assertRejectsWithCode(() => engine.generateForLead('lead_fantasma', {}), 'not-found');
  });

  await t('generateForLead: lead arquivado rejeita failed-precondition', async () => {
    await seedLead(db, { id: 'oe_lead_archived', organizacaoNome: 'X', archived: true });
    const engine = buildEngine(() => ({ message: 'oi' }));
    await assertRejectsWithCode(() => engine.generateForLead('oe_lead_archived', {}), 'failed-precondition');
    await db.collection('leads').doc('oe_lead_archived').delete();
  });

  await t('generateForLead: sucesso cria outboundMessages/{leadId} com status ready_for_review', async () => {
    await seedLead(db, { id: 'oe_lead_1', organizacaoNome: 'Clube Outbound Teste' });
    const engine = buildEngine(() => ({
      subject: 'Assunto contextual', message: 'Olá, vi que vocês...', cta: 'Podemos conversar 15min?',
      personalizationSummary: 'Usou evidência de prospecção', motivos: ['Segmento compatível'],
      evidence: [{ url: 'https://x.com', informacaoExtraida: 'fato real' }],
    }));
    const result = await engine.generateForLead('oe_lead_1', { channel: 'email', createdBy: 'admin_1' });
    assert.strictEqual(result.status, 'ready_for_review');

    const doc = (await db.collection('outboundMessages').doc('oe_lead_1').get()).data();
    assert.strictEqual(doc.status, 'ready_for_review');
    assert.strictEqual(doc.subject, 'Assunto contextual');
    assert.strictEqual(doc.channel, 'email');
    assert.strictEqual(doc.generationCount, 1);

    await cleanupOutbound('oe_lead_1');
    await db.collection('leads').doc('oe_lead_1').delete();
  });

  await t('generateForLead: usa aiProspecting.score/evidence do lead quando disponível (contexto pro prompt)', async () => {
    await seedLead(db, {
      id: 'oe_lead_2', organizacaoNome: 'Clube Prospectado',
      aiProspecting: { score: 88, qualificacao: 'quente', evidence: [{ url: 'https://y.com', informacaoExtraida: 'evento recente' }] },
    });
    let capturedLead = null;
    const engine = buildEngine((args) => { capturedLead = args.lead; return { message: 'msg', evidence: [] }; });
    await engine.generateForLead('oe_lead_2', { channel: 'email' });

    assert.strictEqual(capturedLead.aiProspecting.score, 88);
    assert.strictEqual(capturedLead.aiProspecting.evidence[0].informacaoExtraida, 'evento recente');

    await cleanupOutbound('oe_lead_2');
    await db.collection('leads').doc('oe_lead_2').delete();
  });

  /* =======================================================================
     Concorrência — nunca 2 gerações simultâneas pro mesmo lead
     ======================================================================= */

  await t('generateForLead: duas chamadas simultâneas pro MESMO lead — só uma tem sucesso, a outra rejeita already-exists', async () => {
    await seedLead(db, { id: 'oe_lead_concurrent', organizacaoNome: 'Clube Concorrente' });
    const engine = buildEngine(() => ({ message: 'msg', evidence: [] }));

    const results = await Promise.allSettled([
      engine.generateForLead('oe_lead_concurrent', { channel: 'email' }),
      engine.generateForLead('oe_lead_concurrent', { channel: 'email' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(fulfilled.length, 1, 'exatamente uma das duas chamadas concorrentes deveria ter sucesso');
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason.code, 'already-exists');

    await cleanupOutbound('oe_lead_concurrent');
    await db.collection('leads').doc('oe_lead_concurrent').delete();
  });

  /* =======================================================================
     Retry e falha — nunca lança por resposta ruim do modelo
     ======================================================================= */

  await t('generateForLead: Claude sem mensagem em ambas tentativas → status "failed", nunca lança exceção', async () => {
    await seedLead(db, { id: 'oe_lead_empty', organizacaoNome: 'Clube Vazio' });
    const engine = buildEngine(() => ({ message: '' })); // sempre vazio
    const result = await engine.generateForLead('oe_lead_empty', {});
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error);

    const doc = (await db.collection('outboundMessages').doc('oe_lead_empty').get()).data();
    assert.strictEqual(doc.status, 'failed');

    await cleanupOutbound('oe_lead_empty');
    await db.collection('leads').doc('oe_lead_empty').delete();
  });

  await t('generateForLead: retry — 1ª tentativa falha (erro de rede/rate limit), 2ª tem sucesso', async () => {
    await seedLead(db, { id: 'oe_lead_retry', organizacaoNome: 'Clube Retry' });
    const engine = buildEngine((args, attempt) => (attempt === 1 ? new Error('Claude API: overloaded_error') : { message: 'sucesso na 2ª tentativa', evidence: [] }));
    const result = await engine.generateForLead('oe_lead_retry', {});
    assert.strictEqual(result.status, 'ready_for_review');
    const doc = (await db.collection('outboundMessages').doc('oe_lead_retry').get()).data();
    assert.strictEqual(doc.message, 'sucesso na 2ª tentativa');
    assert.strictEqual(doc.generationCount, 1, 'só a tentativa bem-sucedida vira versão — retries não contam como gerações separadas');

    await cleanupOutbound('oe_lead_retry');
    await db.collection('leads').doc('oe_lead_retry').delete();
  });

  /* =======================================================================
     Regeneração — nunca duplica documento
     ======================================================================= */

  await t('generateForLead chamado 2x sequencialmente: mesmo documento, generationCount incrementa, histórico preserva as 2 versões', async () => {
    await seedLead(db, { id: 'oe_lead_regen', organizacaoNome: 'Clube Regeração' });
    const engine = buildEngine((args, attempt) => ({ message: `versão ${attempt}`, evidence: [] }));

    await engine.generateForLead('oe_lead_regen', {});
    await engine.generateForLead('oe_lead_regen', {});

    const allDocs = await db.collection('outboundMessages').where('leadId', '==', 'oe_lead_regen').get();
    assert.strictEqual(allDocs.size, 1, 'nunca um segundo documento pro mesmo lead');
    assert.strictEqual(allDocs.docs[0].data().generationCount, 2);

    const versions = await db.collection('outboundMessages').doc('oe_lead_regen').collection('versions').get();
    assert.strictEqual(versions.size, 2);

    await cleanupOutbound('oe_lead_regen');
    await db.collection('leads').doc('oe_lead_regen').delete();
  });

  /* =======================================================================
     Geração em lote
     ======================================================================= */

  await t('requestBatch: leadIds vazio rejeita invalid-argument', async () => {
    const engine = buildEngine(() => ({ message: 'x' }));
    await assertRejectsWithCode(() => engine.requestBatch({ leadIds: [] }), 'invalid-argument');
  });

  await t('requestBatch: acima do limite máximo rejeita invalid-argument (nunca todos os leads sem ação explícita)', async () => {
    const engine = buildEngine(() => ({ message: 'x' }));
    const many = Array.from({ length: 5 }, (_, i) => `lead_${i}`);
    await assertRejectsWithCode(() => engine.requestBatch({ leadIds: many, maxLeads: 3 }), 'invalid-argument');
  });

  await t('requestBatch + executeBatch: gera pra todos os leads do lote, um item falho não trava os outros', async () => {
    await seedLead(db, { id: 'oe_batch_1', organizacaoNome: 'Lote 1' });
    await seedLead(db, { id: 'oe_batch_2', organizacaoNome: 'Lote 2' });
    await seedLead(db, { id: 'oe_batch_3', organizacaoNome: 'Lote 3', archived: true }); // vai falhar (arquivado)

    const engine = buildEngine((args) => ({ message: `abordagem para ${args.lead.organizacaoNome}`, evidence: [] }));
    const { batchId, total } = await engine.requestBatch({ leadIds: ['oe_batch_1', 'oe_batch_2', 'oe_batch_3'], requestedBy: 'admin_1' });
    assert.strictEqual(total, 3);

    await engine.executeBatch(batchId);

    const batch = (await db.collection('outboundBatches').doc(batchId).get()).data();
    assert.strictEqual(batch.status, 'completed');
    assert.strictEqual(batch.summary.total, 3);
    assert.strictEqual(batch.summary.readyForReview, 2);
    assert.strictEqual(batch.summary.failed, 1);
    assert.strictEqual(batch.results.length, 3);

    const doc1 = (await db.collection('outboundMessages').doc('oe_batch_1').get()).data();
    assert.strictEqual(doc1.status, 'ready_for_review');
    const doc3exists = (await db.collection('outboundMessages').doc('oe_batch_3').get()).exists;
    assert.strictEqual(doc3exists, false, 'lead arquivado nunca chega a reivindicar o claim (falha antes disso)');

    await cleanupOutbound('oe_batch_1');
    await cleanupOutbound('oe_batch_2');
    await db.collection('leads').doc('oe_batch_1').delete();
    await db.collection('leads').doc('oe_batch_2').delete();
    await db.collection('leads').doc('oe_batch_3').delete();
    await db.collection('outboundBatches').doc(batchId).delete();
  });

  await t('executeBatch: idempotente — chamar de novo num lote já "completed" não reprocessa', async () => {
    await seedLead(db, { id: 'oe_batch_idem', organizacaoNome: 'Lote Idempotente' });
    const engine = buildEngine(() => ({ message: 'msg', evidence: [] }));
    const { batchId } = await engine.requestBatch({ leadIds: ['oe_batch_idem'] });
    await engine.executeBatch(batchId);
    const before = (await db.collection('outboundMessages').doc('oe_batch_idem').get()).data();

    await engine.executeBatch(batchId); // 2ª chamada, mesmo batchId — não deve gerar de novo
    const after = (await db.collection('outboundMessages').doc('oe_batch_idem').get()).data();
    assert.strictEqual(after.generationCount, before.generationCount);

    await cleanupOutbound('oe_batch_idem');
    await db.collection('leads').doc('oe_batch_idem').delete();
    await db.collection('outboundBatches').doc(batchId).delete();
  });
};
