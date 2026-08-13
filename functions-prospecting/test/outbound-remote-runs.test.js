// functions/test/outbound-remote-runs.test.js — lib/outbound/remoteRuns.js,
// controle de concorrência do botão "Executar Outbound IA" (mesmo idioma de
// lock atômico de lib/prospecting/engine.js). Nunca chama a API do GitHub —
// só o Firestore (emulador).
const assert = require('assert');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { createRemoteRunsService } = require('../lib/outbound/remoteRuns');

module.exports = async function run({ db, t }) {
  const serverTimestamp = () => new Date();
  const service = createRemoteRunsService({ db, serverTimestamp });

  await t('requestRun: cria o doc "pending" e o lock', async () => {
    const { runId } = await service.requestRun({
      leadIdsPlanned: ['lead_a', 'lead_b'], totalQualificados: 5, jaAbordados: 1, requestedBy: 'admin_1',
    });
    const run = await service.getRun(runId);
    assert.strictEqual(run.status, 'pending');
    assert.deepStrictEqual(run.leadIdsPlanned, ['lead_a', 'lead_b']);

    const lockSnap = await db.collection('outboundRemoteRuns').doc('_lock').get();
    assert.strictEqual(lockSnap.data().status, 'pending');
    assert.strictEqual(lockSnap.data().runId, runId);
  });

  await t('requestRun: segunda solicitação enquanto já existe uma pending/running rejeita already-exists', async () => {
    await assertRejectsWithCode(
      () => service.requestRun({ leadIdsPlanned: ['lead_c'], totalQualificados: 1, jaAbordados: 0, requestedBy: 'admin_2' }),
      'already-exists'
    );
  });

  await t('markStarted: muda status pra "running" e atualiza o lock', async () => {
    const lockSnap = await db.collection('outboundRemoteRuns').doc('_lock').get();
    const runId = lockSnap.data().runId;
    await service.markStarted(runId);
    const run = await service.getRun(runId);
    assert.strictEqual(run.status, 'running');
    assert.ok(run.startedAt);
  });

  await t('markFinished: libera o lock (status "idle") mesmo em falha', async () => {
    const lockSnap = await db.collection('outboundRemoteRuns').doc('_lock').get();
    const runId = lockSnap.data().runId;
    await service.markFinished(runId, 'failed', { error: 'Erro simulado' });

    const run = await service.getRun(runId);
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.error, 'Erro simulado');

    const newLockSnap = await db.collection('outboundRemoteRuns').doc('_lock').get();
    assert.strictEqual(newLockSnap.data().status, 'idle');
  });

  await t('requestRun: lock liberado permite uma nova solicitação', async () => {
    const { runId } = await service.requestRun({ leadIdsPlanned: ['lead_d'], totalQualificados: 3, jaAbordados: 0, requestedBy: 'admin_3' });
    assert.ok(runId);
    await service.markFinished(runId, 'completed', { summary: { total: 1, gerados: 1, falharam: 0 } });
  });

  await t('requestRun: lock "pending"/"running" muito antigo é tratado como travado (self-heal)', async () => {
    const { runId: staleRunId } = await service.requestRun({ leadIdsPlanned: ['lead_e'], totalQualificados: 1, jaAbordados: 0, requestedBy: 'admin_4' });
    await db.collection('outboundRemoteRuns').doc('_lock').update({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) });

    const { runId: newRunId } = await service.requestRun({ leadIdsPlanned: ['lead_f'], totalQualificados: 1, jaAbordados: 0, requestedBy: 'admin_5' });
    assert.ok(newRunId);
    assert.notStrictEqual(newRunId, staleRunId);
    await service.markFinished(newRunId, 'completed', {});
  });

  await t('markFinishedIfStillRunning: idempotente — não faz nada se o run já não está "running"', async () => {
    const { runId } = await service.requestRun({ leadIdsPlanned: ['lead_g'], totalQualificados: 1, jaAbordados: 0, requestedBy: 'admin_6' });
    await service.markStarted(runId);
    await service.markFinished(runId, 'completed', { summary: { total: 1, gerados: 1, falharam: 0 } });

    const result = await service.markFinishedIfStillRunning(runId, { error: 'não deveria sobrescrever' });
    assert.strictEqual(result.skipped, true);
    const run = await service.getRun(runId);
    assert.strictEqual(run.status, 'completed', 'não deveria ter sido sobrescrito pra failed');
  });

  await t('markFinishedIfStillRunning: finaliza como "failed" se ainda estava "running" (fallback real do workflow)', async () => {
    const { runId } = await service.requestRun({ leadIdsPlanned: ['lead_h'], totalQualificados: 1, jaAbordados: 0, requestedBy: 'admin_7' });
    await service.markStarted(runId);

    const result = await service.markFinishedIfStillRunning(runId);
    assert.strictEqual(result.skipped, false);
    const run = await service.getRun(runId);
    assert.strictEqual(run.status, 'failed');
  });
};
