// functions-prospecting/scripts/outbound-remote-run-finish.js — chamado
// pelo Claude Code (ou pelo passo de fallback do workflow, `if: always()`)
// ao final da execução remota, pra marcar outboundRemoteRuns/{runId} como
// "completed"/"failed" e liberar o lock (ver CLAUDE.md "Botão Executar
// Outbound IA"). Idempotente: se o run já não estiver "running" (porque já
// foi finalizado), não faz nada — permite o passo de fallback do workflow
// rodar sempre com `if: always()` sem risco de sobrescrever um resultado
// bem-sucedido já gravado pelo Claude Code.
//
// Uso:
//   node scripts/outbound-remote-run-finish.js --runId=abc123 --status=completed --summary='{"total":3,"gerados":3,"falharam":0}'
//   node scripts/outbound-remote-run-finish.js --runId=abc123 --fallback   (só finaliza se ainda "running", ver markFinishedIfStillRunning)

const admin = require('firebase-admin');
const { createRemoteRunsService } = require('../lib/outbound/remoteRuns');

function parseArgs(argv) {
  const out = { fallback: false };
  for (const arg of argv) {
    if (arg === '--fallback') { out.fallback = true; continue; }
    const m = arg.match(/^--([a-zA-Z]+)=([\s\S]*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const { runId, status, summary, error, fallback } = parseArgs(process.argv.slice(2));
  if (!runId) throw new Error('--runId é obrigatório.');

  if (!admin.apps.length) admin.initializeApp({ projectId: 'clubecavalobonfim' });
  const db = admin.firestore();
  const remoteRunsService = createRemoteRunsService({ db, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });

  if (fallback) {
    const result = await remoteRunsService.markFinishedIfStillRunning(runId, {
      error: 'Workflow terminou sem o Claude Code chamar outbound-remote-run-finish.js explicitamente — ver logs do GitHub Actions.',
    });
    console.log(result.skipped
      ? `outbound-remote-run-finish (fallback): runId=${runId} já estava finalizado, nada a fazer.`
      : `outbound-remote-run-finish (fallback): runId=${runId} marcado como "failed" (nunca foi finalizado explicitamente).`);
    process.exit(0);
  }

  if (!['completed', 'failed'].includes(status)) {
    throw new Error('--status precisa ser "completed" ou "failed" (ou use --fallback).');
  }
  const parsedSummary = summary ? JSON.parse(summary) : null;
  await remoteRunsService.markFinished(runId, status, { summary: parsedSummary, error: error || null });
  console.log(`outbound-remote-run-finish: runId=${runId} marcado como "${status}".`);
  process.exit(0);
}

main().catch((e) => {
  console.error('outbound-remote-run-finish: erro:', e.message);
  process.exit(1);
});
