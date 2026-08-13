// functions-prospecting/scripts/outbound-remote-run-start.js — chamado pelo
// workflow .github/workflows/outbound-weekly.yml, ANTES do Claude Code
// começar a gerar, pra marcar outboundRemoteRuns/{runId} como "running" (ver
// CLAUDE.md "Botão Executar Outbound IA"). Autenticado via Application
// Default Credentials — dentro do runner, isso vem do
// google-github-actions/auth (Workload Identity Federation), fora dele (uso
// local/debug) vem de `gcloud auth application-default login`, igual aos
// outros scripts deste diretório.
//
// Uso: node scripts/outbound-remote-run-start.js --runId=abc123

const admin = require('firebase-admin');
const { createRemoteRunsService } = require('../lib/outbound/remoteRuns');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const { runId } = parseArgs(process.argv.slice(2));
  if (!runId) throw new Error('--runId é obrigatório.');

  if (!admin.apps.length) admin.initializeApp({ projectId: 'clubecavalobonfim' });
  const db = admin.firestore();
  const remoteRunsService = createRemoteRunsService({ db, serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() });

  await remoteRunsService.markStarted(runId);
  console.log(`outbound-remote-run-start: runId=${runId} marcado como "running".`);
  process.exit(0);
}

main().catch((e) => {
  console.error('outbound-remote-run-start: erro:', e.message);
  process.exit(1);
});
