// functions/lib/outbound/messages.js — estado e histórico de abordagens do
// Agente de Outbound (outboundMessages/{leadId}). Usa o PRÓPRIO leadId como
// ID do documento — nunca um segundo cadastro de prospect (ver CLAUDE.md
// "Agente de Outbound", "Relação com o Lead"): no máximo UMA abordagem ativa
// por lead, com histórico de versões em vez de documentos duplicados a cada
// geração/regeneração/edição.
//
// Contrato (outboundMessages/{leadId}):
//   leadId, channel: "email"|"whatsapp"|"linkedin"|"sms"|"outro"
//   status: "pending"|"generating"|"ready_for_review"|"approved"|"rejected"|
//     "edited"|"sent"|"responded"|"failed"
//   subject, message, cta, personalizationSummary (denormalizado da versão atual)
//   motivos[], evidence[], researchPerformed (idem)
//   currentVersionId, generationCount, totalCostUsd, totalSearchesPerformed
//   error (só quando status="failed")
//   createdBy, createdAt, updatedAt
//   approvedAt, rejectedAt, editedAt, sentAt, respondedAt, reviewedBy
//
// outboundMessages/{leadId}/versions/{versionId} — append-only, nunca editado/apagado:
//   source: "ai_generated"|"human_edited"
//   trigger: "initial"|"regenerate"|"edit"
//   subject, message, cta, personalizationSummary, motivos[], evidence[]
//   researchPerformed, usage, costUsd, searchesPerformed (só em ai_generated)
//   createdBy, createdAt

const functions = require('firebase-functions');

const STATUSES = ['pending', 'generating', 'ready_for_review', 'approved', 'rejected', 'edited', 'sent', 'responded', 'failed'];
const CHANNELS = ['email', 'whatsapp', 'linkedin', 'sms', 'outro'];
// Margem sobre o tempo razoável de UMA geração (1-3 chamadas Claude) — se
// "generating" ficar preso além disso, é uma execução travada/crashada, não
// uma em andamento de verdade (mesmo raciocínio de RUNNING_STALE_MS em
// lib/prospecting/engine.js, só que numa escala bem menor).
const GENERATING_STALE_MS = 5 * 60 * 1000;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {string} [opts.collectionName="outboundMessages"]
 */
function createOutboundMessagesService({ db, serverTimestamp, collectionName = 'outboundMessages' } = {}) {
  if (!db) throw new Error('createOutboundMessagesService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createOutboundMessagesService: serverTimestamp é obrigatório.');
  const col = () => db.collection(collectionName);

  /**
   * Reivindica o documento (existente ou novo) pra uma geração. Nunca cria
   * um segundo documento pro mesmo lead: geração inicial = doc novo,
   * regeneração = mesmo doc, status volta pra "generating", conteúdo
   * anterior preservado até a nova versão suceder.
   *
   * Duas etapas deliberadas (mesmo padrão de provisionOrganization em
   * lib/provisioning.js, "resolve corrida de duplo envio"): 1) tentativa
   * atômica de CRIAÇÃO via `.create()` — só uma de duas chamadas
   * concorrentes pro mesmo leadId consegue criar o documento, a outra recebe
   * ALREADY_EXISTS do próprio Firestore; 2) só quando o documento já existe
   * (seja porque é uma regeneração de verdade, seja porque a chamada
   * concorrente "perdeu" a corrida da etapa 1) é que entra a transação de
   * lock/staleness abaixo. Uma transação sozinha com `tx.set()` NÃO
   * resolveria essa corrida — `set()` nunca falha por já existir, só
   * `create()` tem essa garantia de exclusividade.
   * @param {string} leadId
   * @param {{channel: string, createdBy: string}} params
   * @returns {Promise<{channel: string, isRegeneration: boolean}>}
   */
  async function claimForGeneration(leadId, { channel, createdBy }) {
    if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
    if (!CHANNELS.includes(channel)) {
      throw new functions.https.HttpsError('invalid-argument', `channel precisa ser um de: ${CHANNELS.join(', ')}.`);
    }
    const ref = col().doc(leadId);

    try {
      await ref.create({
        leadId, channel, status: 'generating',
        subject: '', message: '', cta: '', personalizationSummary: '',
        motivos: [], evidence: [], researchPerformed: false,
        currentVersionId: null, generationCount: 0, totalCostUsd: 0, totalSearchesPerformed: 0,
        error: null,
        createdBy: createdBy || null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        approvedAt: null, rejectedAt: null, editedAt: null, sentAt: null, respondedAt: null, reviewedBy: null,
      });
      return { channel, isRegeneration: false };
    } catch (e) {
      if (e.code !== 6 && e.code !== 'already-exists') throw e; // 6 = ALREADY_EXISTS (gRPC)
    }

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data.status === 'generating') {
        const updatedAtMs = data.updatedAt?.toMillis ? data.updatedAt.toMillis() : 0;
        const isStale = (Date.now() - updatedAtMs) > GENERATING_STALE_MS;
        if (!isStale) {
          throw new functions.https.HttpsError('already-exists', 'Já existe uma geração em andamento para este lead — aguarde alguns instantes e tente novamente.');
        }
      }
      if (data.status === 'sent' || data.status === 'responded') {
        throw new functions.https.HttpsError('failed-precondition', `Esta abordagem já foi marcada como "${data.status}" — não é possível regenerar depois do envio.`);
      }

      tx.update(ref, { status: 'generating', channel: channel || data.channel, updatedAt: serverTimestamp() });
      return { channel: channel || data.channel, isRegeneration: true };
    });
  }

  /** Registra uma versão bem-sucedida (IA ou edição humana) e atualiza o doc denormalizado. */
  async function recordVersion(leadId, version) {
    const ref = col().doc(leadId);
    const versionRef = ref.collection('versions').doc();
    const isAi = version.source === 'ai_generated';
    const status = isAi ? 'ready_for_review' : 'edited';

    await versionRef.set({
      source: version.source,
      trigger: version.trigger,
      subject: str(version.subject),
      message: str(version.message),
      cta: str(version.cta),
      personalizationSummary: str(version.personalizationSummary),
      motivos: Array.isArray(version.motivos) ? version.motivos : [],
      evidence: Array.isArray(version.evidence) ? version.evidence : [],
      researchPerformed: !!version.researchPerformed,
      usage: version.usage || null,
      costUsd: Number.isFinite(version.costUsd) ? version.costUsd : null,
      searchesPerformed: Number.isFinite(version.searchesPerformed) ? version.searchesPerformed : null,
      createdBy: version.createdBy || null,
      createdAt: serverTimestamp(),
    });

    const update = {
      status,
      subject: str(version.subject),
      message: str(version.message),
      cta: str(version.cta),
      personalizationSummary: str(version.personalizationSummary),
      motivos: Array.isArray(version.motivos) ? version.motivos : [],
      evidence: Array.isArray(version.evidence) ? version.evidence : [],
      researchPerformed: !!version.researchPerformed,
      currentVersionId: versionRef.id,
      updatedAt: serverTimestamp(),
    };
    if (isAi) {
      const before = (await ref.get()).data() || {};
      update.generationCount = (before.generationCount || 0) + 1;
      update.totalCostUsd = (before.totalCostUsd || 0) + (version.costUsd || 0);
      update.totalSearchesPerformed = (before.totalSearchesPerformed || 0) + (version.searchesPerformed || 0);
    } else {
      update.editedAt = serverTimestamp();
      update.editedBy = version.createdBy || null;
    }
    await ref.update(update);
    return { versionId: versionRef.id, status };
  }

  async function markFailed(leadId, { error }) {
    await col().doc(leadId).update({ status: 'failed', error: str(error) || 'Erro desconhecido.', updatedAt: serverTimestamp() });
  }

  /** decision: "approved" | "rejected". Só a partir de um estado que já tem conteúdo revisável. */
  async function setDecision(leadId, decision, { reviewedBy } = {}) {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new functions.https.HttpsError('invalid-argument', 'decision precisa ser "approved" ou "rejected".');
    }
    const ref = col().doc(leadId);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Abordagem para o lead "${leadId}" não existe.`);
    const status = snap.data().status;
    if (!['ready_for_review', 'edited', 'approved', 'rejected'].includes(status)) {
      throw new functions.https.HttpsError('failed-precondition', `Abordagem no estado "${status}" não pode ser ${decision === 'approved' ? 'aprovada' : 'rejeitada'} agora.`);
    }
    const update = { status: decision, reviewedBy: reviewedBy || null, updatedAt: serverTimestamp() };
    update[decision === 'approved' ? 'approvedAt' : 'rejectedAt'] = serverTimestamp();
    await ref.update(update);
  }

  /** Marca como enviada MANUALMENTE pelo comercial — nunca disparado por envio automático (ver CLAUDE.md, "Importante: não enviar automaticamente"). */
  async function markSent(leadId, { sentBy } = {}) {
    const ref = col().doc(leadId);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Abordagem para o lead "${leadId}" não existe.`);
    const status = snap.data().status;
    if (!['approved', 'edited'].includes(status)) {
      throw new functions.https.HttpsError('failed-precondition', 'Só uma abordagem aprovada ou editada pode ser marcada como enviada.');
    }
    await ref.update({ status: 'sent', sentAt: serverTimestamp(), sentBy: sentBy || null, updatedAt: serverTimestamp() });
  }

  async function markResponded(leadId) {
    const ref = col().doc(leadId);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Abordagem para o lead "${leadId}" não existe.`);
    if (snap.data().status !== 'sent') {
      throw new functions.https.HttpsError('failed-precondition', 'Só uma abordagem já enviada pode ser marcada como respondida.');
    }
    await ref.update({ status: 'responded', respondedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  return { claimForGeneration, recordVersion, markFailed, setDecision, markSent, markResponded };
}

module.exports = { createOutboundMessagesService, STATUSES, CHANNELS };
