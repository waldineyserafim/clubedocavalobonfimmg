// functions/lib/prospecting/engine.js — motor de execução do agente de
// Prospecção IA. Separado em duas fases deliberadamente (ver CLAUDE.md deste
// repositório, "Prospecção IA — Arquitetura"):
//
//   requestRun()  — RÁPIDO. Reivindica o lock da campanha (mesmo padrão
//                   atômico de provisionOrganization em lib/provisioning.js)
//                   e cria o doc de execução com status "queued". Chamado
//                   por uma Cloud Function Gen1 leve (callable ou scheduled).
//   executeRun()  — LONGO (minutos). O ciclo iterativo de verdade: pesquisa
//                   → validação → dedup → qualificação → score → criação de
//                   leads → relatório. Chamado por uma Cloud Function Gen2
//                   disparada por trigger do Firestore (onDocumentCreated em
//                   prospectingRuns), com timeout bem maior que o teto de
//                   9 minutos das functions Gen1 deste repositório.
//
// Por que a separação: uma callable síncrona não pode bloquear por 10-25
// minutos (proxy/hosting cortam a conexão bem antes disso) — "Executar
// agora" só PEDE a execução e devolve o runId na hora; o cliente acompanha o
// progresso ao vivo via onSnapshot no doc de prospectingRuns, exatamente
// como o assistente de provisionamento já faz.
//
// Nunca lança exceção pro chamador do trigger — todo erro é capturado e
// gravado no doc de execução (mesma filosofia de step() em
// lib/provisioning.js), e o lock da campanha é SEMPRE liberado no fim
// (bloco finally), mesmo em erro inesperado — nunca deixa uma campanha
// travada em "running" para sempre.

const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');
const { evaluateCandidate } = require('./scoring');
const { buildDedupKeys } = require('./dedup');
const { SEGMENTOS } = require('../leads');

// Margem generosa sobre o timeout máximo configurável de uma campanha
// (1740s, ver campaigns.js) — cobre o caso de a function do motor ter
// travado/crashado sem nunca liberar o lock.
const RUNNING_STALE_MS = 40 * 60 * 1000;

function metricsSnapshot(m) {
  return {
    searchesPerformed: m.searchesPerformed,
    iteracoes: m.iteracoes,
    candidatosAnalisados: m.candidatosAnalisados,
    candidatosRejeitados: m.candidatosRejeitados,
    leadsCriados: m.leadsCriados,
    leadsDuplicados: m.leadsDuplicados,
    scoreMedio: m.scoreCount > 0 ? Math.round((m.scoreSum / m.scoreCount) * 10) / 10 : null,
    custoEstimadoUsd: Math.round(m.custoEstimadoUsd * 10000) / 10000,
  };
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {ReturnType<typeof import('./claudeProvider').createClaudeProvider>} opts.aiProvider
 * @param {ReturnType<typeof import('../leads').createLeadsService>} opts.leadsService
 * @param {ReturnType<typeof import('./dedup').createDedupService>} opts.dedupService
 * @param {(info: object) => Promise<void>} [opts.notify] — best-effort, nunca deixa a execução falhar por causa de e-mail
 */
function createProspectingEngine({ db, serverTimestamp, aiProvider, leadsService, dedupService, notify } = {}) {
  if (!db) throw new Error('createProspectingEngine: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createProspectingEngine: serverTimestamp é obrigatório.');
  if (!aiProvider) throw new Error('createProspectingEngine: aiProvider é obrigatório.');
  if (!leadsService) throw new Error('createProspectingEngine: leadsService é obrigatório.');
  if (!dedupService) throw new Error('createProspectingEngine: dedupService é obrigatório.');

  const campaignsCol = () => db.collection('prospectingCampaigns');
  const runsCol = () => db.collection('prospectingRuns');

  /**
   * @param {object} params
   * @param {string} params.campaignId
   * @param {"manual"|"scheduled"} params.trigger
   * @param {string} [params.requestedBy] — uid do Platform Administrator (só em trigger="manual")
   * @param {string} [params.requestedByEmail]
   * @returns {Promise<{runId: string}|{skipped: true, reason: string}>}
   */
  async function requestRun({ campaignId, trigger, requestedBy, requestedByEmail }) {
    if (!campaignId) throw new functions.https.HttpsError('invalid-argument', 'campaignId é obrigatório.');
    const campaignRef = campaignsCol().doc(campaignId);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(campaignRef);
      if (!snap.exists) throw new functions.https.HttpsError('not-found', `Campanha "${campaignId}" não existe.`);
      const campaign = snap.data();

      if (campaign.status === 'archived') {
        throw new functions.https.HttpsError('failed-precondition', 'Campanha arquivada não pode ser executada.');
      }
      // Execução agendada só roda campanha ativa; execução manual (botão
      // "Executar agora") também exige "active" — "paused" existe
      // justamente pra impedir qualquer execução, agendada ou manual.
      if (campaign.status !== 'active') {
        return { skipped: true, reason: `Campanha está "${campaign.status}", não "active".` };
      }

      if (campaign.campaignStatus === 'running') {
        const updatedAtMs = campaign.updatedAt?.toMillis ? campaign.updatedAt.toMillis() : 0;
        const isStale = (Date.now() - updatedAtMs) > RUNNING_STALE_MS;
        if (!isStale) {
          if (trigger === 'scheduled') return { skipped: true, reason: 'Execução já em andamento.' };
          throw new functions.https.HttpsError('already-exists', 'Esta campanha já tem uma execução em andamento — controle de concorrência (ver CLAUDE.md).');
        }
        logger.warn(`requestRun: campanha ${campaignId} estava "running" há mais de ${RUNNING_STALE_MS / 60000}min — tratando como travada e liberando.`);
      }

      const runRef = runsCol().doc();
      tx.set(runRef, {
        campaignId, trigger, requestedBy: requestedBy || null, requestedByEmail: requestedByEmail || null,
        status: 'queued', startedAt: null, finishedAt: null, stoppedReason: null, error: null,
        steps: [],
        metrics: { searchesPerformed: 0, iteracoes: 0, candidatosAnalisados: 0, candidatosRejeitados: 0, leadsCriados: 0, leadsDuplicados: 0, scoreMedio: null, custoEstimadoUsd: 0 },
        createdAt: serverTimestamp(),
      });
      tx.update(campaignRef, { campaignStatus: 'running', updatedAt: serverTimestamp() });
      return { runId: runRef.id };
    });
  }

  /**
   * Executa o ciclo completo de uma execução já "queued". Idempotente por
   * construção (checa status antes de agir) — seguro de reexecutar se o
   * trigger do Firestore disparar mais de uma vez pro mesmo documento.
   * @param {string} runId
   */
  async function executeRun(runId) {
    const runRef = runsCol().doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return;
    const run = runSnap.data();
    if (run.status !== 'queued') return; // já processado, ou execução duplicada do trigger

    const campaignRef = campaignsCol().doc(run.campaignId);
    const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) {
      await runRef.update({ status: 'failed', finishedAt: serverTimestamp(), error: 'Campanha não existe mais.' });
      return; // nada de campanha pra liberar
    }
    const campaign = campaignSnap.data();

    await runRef.update({ status: 'running', startedAt: serverTimestamp() });

    const startedAtMs = Date.now();
    const timeoutMs = (campaign.execution?.timeoutSeconds || 1500) * 1000;
    const metrics = { searchesPerformed: 0, iteracoes: 0, candidatosAnalisados: 0, candidatosRejeitados: 0, leadsCriados: 0, leadsDuplicados: 0, scoreSum: 0, scoreCount: 0, custoEstimadoUsd: 0 };
    const stepResults = [];
    const buscasAnteriores = [];

    async function step(name, fn) {
      const startedAt = new Date();
      let entry;
      try {
        const result = await fn();
        entry = { name, status: 'ok', startedAt, finishedAt: new Date(), error: null, resumo: result?.summary || null };
      } catch (e) {
        entry = { name, status: 'error', startedAt, finishedAt: new Date(), error: e.message || String(e), resumo: null };
        logger.error(`executeProspectingRun: passo "${name}" falhou (runId=${runId}): ${entry.error}`);
      }
      stepResults.push(entry);
      await runRef.update({ steps: stepResults, metrics: metricsSnapshot(metrics) }).catch(() => {});
      return entry;
    }

    let finalStatus = 'completed';
    let errorMessage = null;

    try {
      const maxIterations = campaign.execution?.maxIterations || 5;
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (metrics.leadsCriados >= campaign.execution.maxLeadsPerRun) break;
        if (metrics.candidatosAnalisados >= campaign.execution.maxCandidatesProcessed) break;
        if (Date.now() - startedAtMs > timeoutMs) break;
        if (metrics.custoEstimadoUsd >= campaign.execution.limiteConsumoUsd) break;

        await step(`pesquisa_${iteration}`, async () => {
          const iterationContext = {
            leadsEncontrados: metrics.leadsCriados,
            metaLeads: campaign.execution.maxLeadsPerRun,
            buscasAnteriores,
          };
          const result = await aiProvider.researchIteration(campaign, iterationContext);
          metrics.searchesPerformed += result.searchesPerformed || 0;
          metrics.custoEstimadoUsd += result.costUsd || 0;
          metrics.iteracoes = iteration;
          if (result.buscaResumo) buscasAnteriores.push(result.buscaResumo);

          let leadsNestaIteracao = 0;
          for (const candidate of result.candidates || []) {
            if (metrics.candidatosAnalisados >= campaign.execution.maxCandidatesProcessed) break;
            if (metrics.leadsCriados >= campaign.execution.maxLeadsPerRun) break;
            metrics.candidatosAnalisados += 1;

            try {
              const evalResult = evaluateCandidate(candidate, campaign.qualification);
              if (!evalResult.valid || evalResult.qualificacao !== 'quente') {
                metrics.candidatosRejeitados += 1;
                continue;
              }

              const dedupKeys = buildDedupKeys(candidate);
              const duplicateLeadId = await dedupService.findDuplicateLeadId(dedupKeys);
              if (duplicateLeadId) {
                metrics.leadsDuplicados += 1;
                continue;
              }

              const leadFields = {
                organizacaoNome: candidate.organizacaoNome,
                segmento: SEGMENTOS.includes(candidate.segmento) ? candidate.segmento : null,
                cidade: String(candidate.cidade || ''),
                estado: String(candidate.estado || ''),
                contatoNome: String(candidate.contatoNome || ''),
                contatoCargo: String(candidate.contatoCargo || ''),
                contatoWhatsapp: String(candidate.contatoWhatsapp || ''),
                contatoEmail: String(candidate.contatoEmail || ''),
                origem: 'prospeccao',
                observacoes: String(candidate.motivoQualificacao || '').slice(0, 2000),
              };
              // Leads gerados por IA nascem atribuídos a quem CRIOU a campanha
              // (Platform Administrator/Owner) — mesma semântica de ownerUid/
              // responsavelUid de lib/leads.js, reatribuível depois via updateLead.
              const { id: leadId } = await leadsService.createLead(leadFields, { ownerUid: campaign.createdBy });
              await db.collection('leads').doc(leadId).update({
                aiProspecting: {
                  campaignId: run.campaignId,
                  runId,
                  score: evalResult.score,
                  qualificacao: evalResult.qualificacao,
                  confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
                  evidence: (candidate.evidence || []).slice(0, 20).map((e) => ({
                    url: String(e.url || ''),
                    titulo: String(e.titulo || ''),
                    tipoFonte: String(e.tipoFonte || ''),
                    informacaoExtraida: String(e.informacaoExtraida || '').slice(0, 1000),
                  })),
                  discoveredAt: serverTimestamp(),
                  lastVerifiedAt: serverTimestamp(),
                },
              });
              await dedupService.registerDedupKeys(dedupKeys, leadId, { serverTimestamp });

              metrics.leadsCriados += 1;
              metrics.scoreSum += evalResult.score;
              metrics.scoreCount += 1;
              leadsNestaIteracao += 1;
            } catch (candidateError) {
              // Um candidato malformado nunca derruba a iteração inteira.
              metrics.candidatosRejeitados += 1;
              logger.warn(`executeProspectingRun: candidato descartado por erro (runId=${runId}): ${candidateError.message}`);
            }
          }

          return { summary: `${(result.candidates || []).length} candidato(s) avaliados nesta iteração, ${leadsNestaIteracao} lead(s) criado(s).` };
        });
      }

      const stoppedReason =
        metrics.leadsCriados >= campaign.execution.maxLeadsPerRun ? 'meta_atingida'
          : metrics.candidatosAnalisados >= campaign.execution.maxCandidatesProcessed ? 'max_candidatos'
            : (Date.now() - startedAtMs > timeoutMs) ? 'timeout'
              : metrics.custoEstimadoUsd >= campaign.execution.limiteConsumoUsd ? 'limite_consumo'
                : 'max_iterations';
      // "Nunca sacrificar qualidade pra alcançar a meta" — max_iterations/menos
      // leads do que o teto é um resultado ACEITÁVEL, não uma interrupção;
      // só timeout/limite_consumo/max_candidatos são de fato "interrompida"
      // (a execução foi cortada por um limite de recurso, não terminou o ciclo).
      finalStatus = ['timeout', 'limite_consumo', 'max_candidatos'].includes(stoppedReason) ? 'interrompida' : 'completed';

      await runRef.update({
        status: finalStatus,
        stoppedReason,
        finishedAt: serverTimestamp(),
        steps: stepResults,
        metrics: metricsSnapshot(metrics),
      });
    } catch (e) {
      finalStatus = 'failed';
      errorMessage = e.message || String(e);
      logger.error(`executeProspectingRun: falha não tratada (runId=${runId}): ${errorMessage}`);
      await runRef.update({
        status: 'failed',
        error: errorMessage,
        finishedAt: serverTimestamp(),
        steps: stepResults,
        metrics: metricsSnapshot(metrics),
      }).catch(() => {});
    } finally {
      // SEMPRE libera o lock, mesmo em erro inesperado — nunca deixa uma
      // campanha travada em "running" pra sempre (controle de concorrência).
      const summary = metricsSnapshot(metrics);
      await campaignRef.update({
        campaignStatus: 'idle',
        lastRunAt: serverTimestamp(),
        lastRunSummary: { runId, status: finalStatus, ...summary },
        updatedAt: serverTimestamp(),
      }).catch((e) => logger.error(`executeProspectingRun: falha ao liberar lock da campanha ${run.campaignId}: ${e.message}`));

      if (notify) {
        await notify({ campaign, campaignId: run.campaignId, runId, status: finalStatus, metrics: summary, error: errorMessage })
          .catch((e) => logger.warn(`executeProspectingRun: falha ao notificar (ignorado): ${e.message}`));
      }
    }
  }

  return { requestRun, executeRun };
}

module.exports = { createProspectingEngine, RUNNING_STALE_MS, metricsSnapshot };
