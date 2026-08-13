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
//
// Usa @google-cloud/firestore DIRETO, não firebase-admin: o SDK do
// firebase-admin não suporta credenciais de Workload Identity Federation
// exportadas pelo google-github-actions/auth ("This option is not supported
// by Firebase Admin SDK" — doc oficial da action; confirmado também na
// prática, "Invalid contents in the credentials file"). @google-cloud/
// firestore fala com o google-auth-library por baixo, que suporta WIF
// nativamente — funciona igual com ADC local e com WIF no runner.

const { Firestore, FieldValue } = require('@google-cloud/firestore');
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

  const db = new Firestore({ projectId: 'clubecavalobonfim' });
  const remoteRunsService = createRemoteRunsService({ db, serverTimestamp: () => FieldValue.serverTimestamp() });

  await remoteRunsService.markStarted(runId);
  console.log(`outbound-remote-run-start: runId=${runId} marcado como "running".`);
  process.exit(0);
}

main().catch((e) => {
  console.error('outbound-remote-run-start: erro:', e.message);
  process.exit(1);
});
