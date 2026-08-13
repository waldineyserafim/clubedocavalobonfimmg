// functions/lib/outbound/remoteRuns.js — controle de concorrência e estado
// do botão "Executar Outbound IA" (ver CLAUDE.md "Botão Executar Outbound
// IA"). Mesmo idioma de lock atômico de lib/prospecting/engine.js
// (requestRun/RUNNING_STALE_MS) — um único doc singleton (`_lock`) guarda o
// estado corrente, e cada execução tem seu próprio doc de auditoria em
// outboundRemoteRuns/{runId}.
//
// Ciclo de vida de um run: "pending" (criado, workflow disparado, Claude
// Code ainda não começou) → "running" (outbound-remote-run-start.js) →
// "completed"|"failed" (outbound-remote-run-finish.js). Lido tanto pelas
// Cloud Functions (requestOutboundRemoteRun) quanto pelos scripts que rodam
// DENTRO do GitHub Actions runner (nunca duas implementações do mesmo lock).

const functions = require('firebase-functions');

const LOCK_DOC_ID = '_lock';
// Margem generosa sobre o timeout do workflow do GitHub Actions (25min, ver
// .github/workflows/outbound-weekly.yml) — cobre o caso do runner ter
// travado/crashado sem nunca chamar outbound-remote-run-finish.js.
const RUNNING_STALE_MS = 40 * 60 * 1000;

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 */
function createRemoteRunsService({ db, serverTimestamp } = {}) {
  if (!db) throw new Error('createRemoteRunsService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createRemoteRunsService: serverTimestamp é obrigatório.');
  const col = () => db.collection('outboundRemoteRuns');

  /**
   * Reivindica o lock e cria o doc de execução — chamado pela Cloud Function
   * requestOutboundRemoteRun, DEPOIS de já ter calculado os leads planejados
   * (ver eligibility.js). Nunca cria dois runs "pending"/"running" ao mesmo
   * tempo.
   * @param {object} params
   * @param {string[]} params.leadIdsPlanned
   * @param {number} params.totalQualificados
   * @param {number} params.jaAbordados
   * @param {string} params.requestedBy
   * @param {string} [params.requestedByEmail]
   */
  async function requestRun({ leadIdsPlanned, totalQualificados, jaAbordados, requestedBy, requestedByEmail }) {
    const lockRef = col().doc(LOCK_DOC_ID);

    return db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const lock = lockSnap.exists ? lockSnap.data() : null;

      if (lock && ['pending', 'running'].includes(lock.status)) {
        const updatedAtMs = lock.updatedAt?.toMillis ? lock.updatedAt.toMillis() : 0;
        const isStale = (Date.now() - updatedAtMs) > RUNNING_STALE_MS;
        if (!isStale) {
          throw new functions.https.HttpsError('already-exists', 'Já existe uma execução de Outbound em andamento.');
        }
      }

      const runRef = col().doc();
      tx.set(runRef, {
        status: 'pending',
        leadIdsPlanned, totalQualificados, jaAbordados,
        requestedBy: requestedBy || null, requestedByEmail: requestedByEmail || null,
        workflowRunUrl: null,
        startedAt: null, finishedAt: null, summary: null, error: null,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      tx.set(lockRef, { status: 'pending', runId: runRef.id, updatedAt: serverTimestamp() });
      return { runId: runRef.id };
    });
  }

  /** Chamado pelo script outbound-remote-run-start.js, já rodando DENTRO do GitHub Actions runner. */
  async function markStarted(runId) {
    const runRef = col().doc(runId);
    await runRef.update({ status: 'running', startedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await col().doc(LOCK_DOC_ID).set({ status: 'running', runId, updatedAt: serverTimestamp() });
  }

  /**
   * Chamado pelo script outbound-remote-run-finish.js ao final (sucesso ou
   * falha) — SEMPRE libera o lock, mesmo em erro (mesma filosofia do
   * `finally` de lib/prospecting/engine.js executeRun — nunca deixa o botão
   * travado pra sempre).
   * @param {string} runId
   * @param {"completed"|"failed"} status
   * @param {object} [params.summary]
   * @param {string} [params.error]
   */
  async function markFinished(runId, status, { summary, error } = {}) {
    if (!['completed', 'failed'].includes(status)) {
      throw new Error('markFinished: status precisa ser "completed" ou "failed".');
    }
    const runRef = col().doc(runId);
    await runRef.update({
      status, finishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      summary: summary || null, error: error || null,
    });
    await col().doc(LOCK_DOC_ID).set({ status: 'idle', runId, updatedAt: serverTimestamp() });
  }

  /** Idempotente — se o run já não estiver "running" (porque markFinished já rodou), não faz nada. Usado como fallback de segurança no workflow (`if: always()`). */
  async function markFinishedIfStillRunning(runId, { error } = {}) {
    const runRef = col().doc(runId);
    const snap = await runRef.get();
    if (!snap.exists || snap.data().status !== 'running') return { skipped: true };
    await markFinished(runId, 'failed', { error: error || 'Execução interrompida sem finalização explícita (ver logs do GitHub Actions).' });
    return { skipped: false };
  }

  async function getRun(runId) {
    const snap = await col().doc(runId).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  return { requestRun, markStarted, markFinished, markFinishedIfStillRunning, getRun, LOCK_DOC_ID, RUNNING_STALE_MS };
}

module.exports = { createRemoteRunsService, RUNNING_STALE_MS };
