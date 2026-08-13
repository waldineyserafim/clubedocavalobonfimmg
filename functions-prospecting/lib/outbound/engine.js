// functions/lib/outbound/engine.js — motor do Agente de Outbound. Uma única
// função (`generateForLead`) usada tanto pela geração individual (callable
// Gen1 síncrona) quanto pela geração em lote (Gen2, disparada por trigger —
// mesmo padrão arquitetural de duas fases de lib/prospecting/engine.js, sem
// duplicar a arquitetura: aqui não precisa de um motor iterativo de
// pesquisa+dedup+score, só reaproveita o mesmo desenho request/execute
// porque um lote de muitos leads pode ultrapassar o teto de 9min do Gen 1).
//
// Nunca lança exceção pro chamador do lote — toda falha de geração é
// registrada no próprio outboundMessages/{leadId} (status "failed") e
// devolvida como resultado, nunca como exceção não tratada, pra um lead com
// problema nunca travar os outros do mesmo lote.

const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');

const MAX_GENERATION_ATTEMPTS = 2; // 1 tentativa + 1 retry — controle de custo/latência (CLAUDE.md "Custo")

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {ReturnType<typeof import('./messages').createOutboundMessagesService>} opts.messagesService
 * @param {ReturnType<typeof import('./salesContext').createSalesContextService>} opts.salesContextService
 * @param {ReturnType<typeof import('../prospecting/claudeProvider').createClaudeProvider>} opts.aiProvider
 */
function createOutboundEngine({ db, serverTimestamp, messagesService, salesContextService, aiProvider } = {}) {
  if (!db) throw new Error('createOutboundEngine: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createOutboundEngine: serverTimestamp é obrigatório.');
  if (!messagesService) throw new Error('createOutboundEngine: messagesService é obrigatório.');
  if (!salesContextService) throw new Error('createOutboundEngine: salesContextService é obrigatório.');
  if (!aiProvider) throw new Error('createOutboundEngine: aiProvider é obrigatório.');

  /**
   * Gera (ou regenera) UMA abordagem pra um lead. Nunca lança por falha de
   * geração — só por erro de uso indevido (leadId ausente, lead inexistente/
   * arquivado, geração já em andamento) antes de sequer começar.
   * @param {string} leadId
   * @param {object} params
   * @param {"email"|"whatsapp"|"linkedin"|"sms"|"outro"} [params.channel]
   * @param {boolean} [params.allowResearch]
   * @param {string} [params.createdBy]
   * @returns {Promise<{leadId: string, status: "ready_for_review"|"failed", error: string|null, costUsd: number, searchesPerformed: number}>}
   */
  async function generateForLead(leadId, { channel = 'email', allowResearch = false, createdBy } = {}) {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) {
      throw new functions.https.HttpsError('not-found', `Lead "${leadId}" não existe.`);
    }
    const lead = { id: leadId, ...leadSnap.data() };
    if (lead.archived) {
      throw new functions.https.HttpsError('failed-precondition', 'Lead arquivado — não é possível gerar abordagem.');
    }

    // Lança 'already-exists' se já houver geração em andamento — propagado
    // pro chamador (não é um caso de "falha de geração", é uso indevido).
    const claim = await messagesService.claimForGeneration(leadId, { channel, createdBy });

    const salesContext = await salesContextService.getSalesContext();

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        const result = await aiProvider.generateOutboundApproach({ lead, salesContext, channel: claim.channel, allowResearch });
        if (!result.message) {
          throw new Error(`Resposta do Claude sem mensagem (stopReason=${result.stopReason || 'desconhecido'}).`);
        }
        await messagesService.recordVersion(leadId, {
          source: 'ai_generated',
          trigger: claim.isRegeneration ? 'regenerate' : 'initial',
          subject: result.subject,
          message: result.message,
          cta: result.cta,
          personalizationSummary: result.personalizationSummary,
          motivos: result.motivos,
          evidence: result.evidence,
          researchPerformed: result.researchPerformed,
          usage: result.usage,
          costUsd: result.costUsd,
          searchesPerformed: result.searchesPerformed,
          createdBy: createdBy || null,
        });
        return { leadId, status: 'ready_for_review', error: null, costUsd: result.costUsd, searchesPerformed: result.searchesPerformed };
      } catch (e) {
        lastError = e;
        logger.warn(`generateForLead: tentativa ${attempt}/${MAX_GENERATION_ATTEMPTS} falhou pro lead ${leadId}: ${e.message}`);
      }
    }

    const errorMessage = lastError?.message || 'Falha desconhecida na geração.';
    await messagesService.markFailed(leadId, { error: errorMessage });
    return { leadId, status: 'failed', error: errorMessage, costUsd: 0, searchesPerformed: 0 };
  }

  /**
   * Cria o doc de lote com status "queued" — RÁPIDO (mesmo raciocínio de
   * requestRun em lib/prospecting/engine.js): quem roda de verdade é
   * executeBatch, abaixo, chamado por trigger de criação do documento.
   * @param {object} params
   * @param {string[]} params.leadIds
   * @param {"email"|"whatsapp"|"linkedin"|"sms"|"outro"} [params.channel]
   * @param {boolean} [params.allowResearch]
   * @param {string} [params.requestedBy]
   * @param {number} [params.maxLeads] — teto de segurança, nunca "todos os leads sem ação explícita" (CLAUDE.md "Geração em lote")
   */
  async function requestBatch({ leadIds, channel = 'email', allowResearch = false, requestedBy, maxLeads = 50 }) {
    const uniqueIds = [...new Set(Array.isArray(leadIds) ? leadIds.filter(Boolean) : [])];
    if (!uniqueIds.length) {
      throw new functions.https.HttpsError('invalid-argument', 'Selecione ao menos um lead.');
    }
    if (uniqueIds.length > maxLeads) {
      throw new functions.https.HttpsError('invalid-argument', `No máximo ${maxLeads} leads por lote — selecione um grupo menor.`);
    }
    const batchRef = db.collection('outboundBatches').doc();
    await batchRef.set({
      leadIds: uniqueIds, channel, allowResearch, requestedBy: requestedBy || null,
      status: 'queued', startedAt: null, finishedAt: null,
      results: [], summary: { total: uniqueIds.length, readyForReview: 0, failed: 0 },
      createdAt: serverTimestamp(),
    });
    return { batchId: batchRef.id, total: uniqueIds.length };
  }

  /** Executa um lote já "queued". Idempotente (checa status antes de agir). */
  async function executeBatch(batchId) {
    const batchRef = db.collection('outboundBatches').doc(batchId);
    const batchSnap = await batchRef.get();
    if (!batchSnap.exists) return;
    const batch = batchSnap.data();
    if (batch.status !== 'queued') return;

    await batchRef.update({ status: 'running', startedAt: serverTimestamp() });

    const results = [];
    for (const leadId of batch.leadIds) {
      try {
        const result = await generateForLead(leadId, { channel: batch.channel, allowResearch: batch.allowResearch, createdBy: batch.requestedBy });
        results.push(result);
      } catch (e) {
        // Erros de uso indevido (lead inexistente/arquivado/já gerando) não
        // devem travar o lote inteiro — registrados como item falho, o
        // próximo lead do lote continua normalmente.
        logger.warn(`executeBatch: lead ${leadId} falhou no lote ${batchId}: ${e.message}`);
        results.push({ leadId, status: 'failed', error: e.message, costUsd: 0, searchesPerformed: 0 });
      }
      // Progresso incremental — pro Painel Master acompanhar via onSnapshot.
      await batchRef.update({
        results,
        summary: {
          total: batch.leadIds.length,
          readyForReview: results.filter((r) => r.status === 'ready_for_review').length,
          failed: results.filter((r) => r.status === 'failed').length,
        },
      }).catch(() => {});
    }

    await batchRef.update({ status: 'completed', finishedAt: serverTimestamp() });
  }

  return { generateForLead, requestBatch, executeBatch };
}

module.exports = { createOutboundEngine, MAX_GENERATION_ATTEMPTS };
