// functions/test/prospecting-engine.test.js — motor de execução
// (lib/prospecting/engine.js) testado DIRETO (não via Cloud Function
// executeProspectingRun, que é task queue function e não se presta ao
// harness `.run()` usado no resto da suíte). leadsService e dedupService
// são os reais (contra o emulador); só o aiProvider é um fake roteirizado —
// "modo seguro de teste que não gera custo de Claude" (CLAUDE.md, "Testes").
const assert = require('assert');
const { seedProspectingCampaign } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { createLeadsService } = require('../lib/leads');
const { createDedupService } = require('../lib/prospecting/dedup');
const { createProspectingEngine } = require('../lib/prospecting/engine');

/** aiProvider fake: devolve um resultado por chamada, na ordem do script — nunca toca a Claude API de verdade. */
function makeScriptedProvider(script) {
  let call = 0;
  return {
    researchIteration: async () => {
      const step = script[call] !== undefined ? script[call] : { candidates: [], buscaResumo: '', costUsd: 0, searchesPerformed: 0 };
      call += 1;
      if (step instanceof Error) throw step;
      return { usage: { inputTokens: 0, outputTokens: 0 }, searchesPerformed: 0, buscaResumo: '', costUsd: 0, ...step };
    },
    callCount: () => call,
  };
}

// Identidade única por chamada por padrão (telefone/e-mail/website/nome) —
// evita que dois candidatos de CASOS DE TESTE DIFERENTES colidam no índice
// de dedup só porque usaram os mesmos valores default. Testes que querem
// testar dedup de propósito continuam controlando isso via `overrides`
// (ex.: mesmo `website` em duas chamadas).
let candidateSeq = 0;
function candidate(overrides = {}) {
  candidateSeq += 1;
  const n = candidateSeq;
  return {
    organizacaoNome: `Clube Engine Teste ${n}`,
    segmento: 'clube',
    cidade: 'Belo Horizonte', estado: 'MG',
    website: `clubengine${n}.com.br`,
    contatoWhatsapp: `3198888${String(n).padStart(4, '0')}`,
    contatoEmail: `contato${n}@clubengine.com.br`,
    score: 90,
    motivoQualificacao: 'Bate com o ICP',
    evidence: [{ url: `https://clubengine${n}.com.br`, titulo: 'Site oficial', tipoFonte: 'site', informacaoExtraida: 'Clube ativo com 200 associados' }],
    ...overrides,
  };
}

module.exports = async function run({ db, t }) {
  const serverTimestamp = () => new Date();
  const leadsService = createLeadsService({ db, serverTimestamp });
  const dedupService = createDedupService({ db });

  function buildEngine(script, { notify } = {}) {
    return createProspectingEngine({
      db, serverTimestamp,
      aiProvider: makeScriptedProvider(script),
      leadsService, dedupService,
      notify,
    });
  }

  /* =======================================================================
     requestRun — controle de concorrência
     ======================================================================= */

  await t('requestRun: reivindica o lock e cria o doc de execução "queued"', async () => {
    const id = await seedProspectingCampaign(db, { id: 'eng_camp_1' });
    const engine = buildEngine([]);
    const result = await engine.requestRun({ campaignId: id, trigger: 'manual', requestedBy: 'admin_x' });
    assert.ok(result.runId);
    const runSnap = await db.collection('prospectingRuns').doc(result.runId).get();
    assert.strictEqual(runSnap.data().status, 'queued');
    assert.strictEqual(runSnap.data().trigger, 'manual');
    const campSnap = await db.collection('prospectingCampaigns').doc(id).get();
    assert.strictEqual(campSnap.data().campaignStatus, 'running');
  });

  await t('requestRun: segunda solicitação enquanto já roda rejeita already-exists (evita 2 execuções simultâneas)', async () => {
    const engine = buildEngine([]);
    await assertRejectsWithCode(
      () => engine.requestRun({ campaignId: 'eng_camp_1', trigger: 'manual', requestedBy: 'admin_y' }),
      'already-exists'
    );
  });

  await t('requestRun: lock "running" muito antigo é tratado como travado e liberado (self-heal)', async () => {
    await db.collection('prospectingCampaigns').doc('eng_camp_1').update({
      updatedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h atrás — bem além de RUNNING_STALE_MS
    });
    const engine = buildEngine([]);
    const result = await engine.requestRun({ campaignId: 'eng_camp_1', trigger: 'manual', requestedBy: 'admin_z' });
    assert.ok(result.runId, 'deveria ter conseguido uma nova execução apesar do lock antigo');
  });

  await t('requestRun: campanha arquivada rejeita failed-precondition', async () => {
    await seedProspectingCampaign(db, { id: 'eng_camp_archived', status: 'archived' });
    const engine = buildEngine([]);
    await assertRejectsWithCode(
      () => engine.requestRun({ campaignId: 'eng_camp_archived', trigger: 'manual' }),
      'failed-precondition'
    );
  });

  await t('requestRun: campanha "paused" é ignorada silenciosamente (skipped), não é erro', async () => {
    await seedProspectingCampaign(db, { id: 'eng_camp_paused', status: 'paused' });
    const engine = buildEngine([]);
    const result = await engine.requestRun({ campaignId: 'eng_camp_paused', trigger: 'scheduled' });
    assert.strictEqual(result.skipped, true);
  });

  // Limpeza dos docs de prospectingRuns/campaigns criados nesta seção
  await db.collection('prospectingCampaigns').doc('eng_camp_1').delete();
  await db.collection('prospectingCampaigns').doc('eng_camp_archived').delete();
  await db.collection('prospectingCampaigns').doc('eng_camp_paused').delete();

  /* =======================================================================
     executeRun — ciclo iterativo completo
     ======================================================================= */

  await t('executeRun: cria lead a partir de candidato qualificado (score >= scoreMinimo) com aiProspecting/evidências', async () => {
    const campaignId = await seedProspectingCampaign(db, {
      id: 'eng_camp_2', createdBy: 'admin_owner_1',
      execution: { frequencia: 'manual', maxLeadsPerRun: 20, maxIterations: 3, maxCandidatesProcessed: 100, timeoutSeconds: 1500, limiteConsumoUsd: 5, horarioPreferencial: '08:00' },
    });
    const engine = buildEngine([{ candidates: [candidate()], buscaResumo: 'busca 1', costUsd: 0.01 }]);
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual', requestedBy: 'admin_owner_1' });

    await engine.executeRun(runId);

    const runSnap = await db.collection('prospectingRuns').doc(runId).get();
    const run = runSnap.data();
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.metrics.leadsCriados, 1);
    assert.strictEqual(run.metrics.candidatosAnalisados, 1);
    assert.strictEqual(run.metrics.candidatosRejeitados, 0);

    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    assert.strictEqual(leadsSnap.size, 1);
    const lead = leadsSnap.docs[0].data();
    assert.strictEqual(lead.origem, 'prospeccao');
    assert.strictEqual(lead.ownerUid, 'admin_owner_1'); // dono da campanha, nunca um uid inventado
    assert.strictEqual(lead.aiProspecting.qualificacao, 'quente');
    assert.strictEqual(lead.aiProspecting.score, 90);
    assert.strictEqual(lead.aiProspecting.evidence.length, 1);

    const campSnap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(campSnap.data().campaignStatus, 'idle', 'lock precisa ser liberado ao final');
    assert.strictEqual(campSnap.data().lastRunSummary.leadsCriados, 1);

    await db.collection('leads').doc(leadsSnap.docs[0].id).delete();
    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: candidato abaixo do scoreMinimo é rejeitado, não vira lead', async () => {
    const campaignId = await seedProspectingCampaign(db, { id: 'eng_camp_3', qualification: { scoreMinimo: 70, dadosObrigatorios: [], evidenciasObrigatorias: 1 } });
    const engine = buildEngine([{ candidates: [candidate({ score: 50 })], costUsd: 0.01 }]);
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId);

    const run = (await db.collection('prospectingRuns').doc(runId).get()).data();
    assert.strictEqual(run.metrics.leadsCriados, 0);
    assert.strictEqual(run.metrics.candidatosRejeitados, 1);
    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    assert.strictEqual(leadsSnap.size, 0);

    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: candidato duplicado (mesmo domínio de um lead já existente) é contado como leadsDuplicados, não cria outro', async () => {
    const campaignId = await seedProspectingCampaign(db, { id: 'eng_camp_4' });
    // 1ª iteração cria o lead; 2ª iteração devolve o MESMO candidato de novo (mesmo website).
    const engine = buildEngine([
      { candidates: [candidate({ organizacaoNome: 'Clube Duplicado', website: 'duplicado.com.br' })], costUsd: 0.01 },
      { candidates: [candidate({ organizacaoNome: 'Clube Duplicado (achado de novo)', website: 'duplicado.com.br' })], costUsd: 0.01 },
    ]);
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId);

    const run = (await db.collection('prospectingRuns').doc(runId).get()).data();
    assert.strictEqual(run.metrics.leadsCriados, 1);
    assert.strictEqual(run.metrics.leadsDuplicados, 1);
    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    assert.strictEqual(leadsSnap.size, 1);

    await db.collection('leads').doc(leadsSnap.docs[0].id).delete();
    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: para ao atingir maxLeadsPerRun (meta_atingida) sem rodar iterações restantes', async () => {
    const campaignId = await seedProspectingCampaign(db, {
      id: 'eng_camp_5',
      execution: { frequencia: 'manual', maxLeadsPerRun: 1, maxIterations: 5, maxCandidatesProcessed: 100, timeoutSeconds: 1500, limiteConsumoUsd: 5, horarioPreferencial: '08:00' },
    });
    const provider = makeScriptedProvider([
      { candidates: [candidate({ website: 'metaatingida.com.br' })], costUsd: 0.01 },
      { candidates: [candidate({ website: 'nuncachamado.com.br' })], costUsd: 0.01 },
    ]);
    const engine = createProspectingEngine({ db, serverTimestamp, aiProvider: provider, leadsService, dedupService });
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId);

    const run = (await db.collection('prospectingRuns').doc(runId).get()).data();
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.stoppedReason, 'meta_atingida');
    assert.strictEqual(run.metrics.leadsCriados, 1);
    assert.strictEqual(provider.callCount(), 1, 'não deveria ter chamado uma 2ª iteração depois de bater a meta');

    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    await db.collection('leads').doc(leadsSnap.docs[0].id).delete();
    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: limite de consumo (limiteConsumoUsd) interrompe a execução — status "interrompida"', async () => {
    const campaignId = await seedProspectingCampaign(db, {
      id: 'eng_camp_6',
      execution: { frequencia: 'manual', maxLeadsPerRun: 20, maxIterations: 10, maxCandidatesProcessed: 100, timeoutSeconds: 1500, limiteConsumoUsd: 0.05, horarioPreferencial: '08:00' },
    });
    // Cada iteração "custa" 0.03 — a 2ª ultrapassa o limite de 0.05, a 3ª nunca deveria rodar.
    const provider = makeScriptedProvider([
      { candidates: [], costUsd: 0.03 },
      { candidates: [], costUsd: 0.03 },
      { candidates: [], costUsd: 0.03 },
    ]);
    const engine = createProspectingEngine({ db, serverTimestamp, aiProvider: provider, leadsService, dedupService });
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId);

    const run = (await db.collection('prospectingRuns').doc(runId).get()).data();
    assert.strictEqual(run.status, 'interrompida');
    assert.strictEqual(run.stoppedReason, 'limite_consumo');
    assert.strictEqual(provider.callCount(), 2, 'deveria ter parado depois da 2ª iteração, nunca rodar a 3ª');

    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: erro do provider numa iteração é registrado como step de erro e a execução segue (não aborta tudo)', async () => {
    const campaignId = await seedProspectingCampaign(db, {
      id: 'eng_camp_7',
      execution: { frequencia: 'manual', maxLeadsPerRun: 20, maxIterations: 2, maxCandidatesProcessed: 100, timeoutSeconds: 1500, limiteConsumoUsd: 5, horarioPreferencial: '08:00' },
    });
    const engine = buildEngine([
      new Error('Claude API: rate_limit_error'),
      { candidates: [candidate({ website: 'depoisdoerro.com.br' })], costUsd: 0.01 },
    ]);
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId);

    const run = (await db.collection('prospectingRuns').doc(runId).get()).data();
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.steps.length, 2);
    assert.strictEqual(run.steps[0].status, 'error');
    assert.match(run.steps[0].error, /rate_limit_error/);
    assert.strictEqual(run.steps[1].status, 'ok');
    assert.strictEqual(run.metrics.leadsCriados, 1, 'a 2ª iteração deveria ter criado o lead normalmente');

    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    await db.collection('leads').doc(leadsSnap.docs[0].id).delete();
    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: falha inesperada (campanha malformada) NUNCA deixa o lock travado — libera e marca run "failed"', async () => {
    const campaignId = await seedProspectingCampaign(db, { id: 'eng_camp_8', execution: null });
    const engine = buildEngine([]);

    // requestRun não valida o formato de `execution` — simula aqui o cenário
    // de dado corrompido chegando direto no executeRun (ex.: doc editado fora
    // do fluxo normal), reivindicando o lock manualmente.
    await db.collection('prospectingCampaigns').doc(campaignId).update({ campaignStatus: 'running' });
    const runRef = await db.collection('prospectingRuns').add({
      campaignId, trigger: 'manual', status: 'queued', startedAt: null, finishedAt: null,
      steps: [], metrics: { searchesPerformed: 0, iteracoes: 0, candidatosAnalisados: 0, candidatosRejeitados: 0, leadsCriados: 0, leadsDuplicados: 0, scoreMedio: null, custoEstimadoUsd: 0 },
    });

    await engine.executeRun(runRef.id);

    const run = (await db.collection('prospectingRuns').doc(runRef.id).get()).data();
    assert.strictEqual(run.status, 'failed');
    assert.ok(run.error);

    const campSnap = await db.collection('prospectingCampaigns').doc(campaignId).get();
    assert.strictEqual(campSnap.data().campaignStatus, 'idle', 'o lock precisa ser liberado mesmo quando a execução falha de forma inesperada');

    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });

  await t('executeRun: notify() é chamado ao final com o resumo da execução, mas nunca derruba a execução se falhar', async () => {
    const campaignId = await seedProspectingCampaign(db, { id: 'eng_camp_9' });
    const notifyCalls = [];
    const engine = buildEngine(
      [{ candidates: [candidate({ website: 'notifica.com.br' })], costUsd: 0.01 }],
      { notify: async (info) => { notifyCalls.push(info); throw new Error('SMTP indisponível (simulado)'); } }
    );
    const { runId } = await engine.requestRun({ campaignId, trigger: 'manual' });
    await engine.executeRun(runId); // não deve lançar mesmo com notify() falhando

    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0].status, 'completed');
    assert.strictEqual(notifyCalls[0].metrics.leadsCriados, 1);

    const leadsSnap = await db.collection('leads').where('aiProspecting.runId', '==', runId).get();
    await db.collection('leads').doc(leadsSnap.docs[0].id).delete();
    await db.collection('prospectingCampaigns').doc(campaignId).delete();
  });
};
