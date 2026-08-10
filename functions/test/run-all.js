// functions/test/run-all.js — orquestra todos os *.test.js contra o emulador.
// Requer FIRESTORE_EMULATOR_HOST e FIREBASE_AUTH_EMULATOR_HOST já setados no
// ambiente (ver npm script "test" no package.json) e os emuladores já rodando
// (`firebase emulators:start --only firestore,auth`). Nunca toca produção.

process.env.FUNCTIONS_TEST_EXPORTS = '1';

const path = require('path');
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST e FIREBASE_AUTH_EMULATOR_HOST precisam estar setados. Use `npm test` (ver package.json) com os emuladores rodando.');
  process.exit(1);
}

// index.js já chama admin.initializeApp() (app default) ao ser importado —
// não inicializamos um segundo app aqui, só reaproveitamos as instâncias.
const fns = require('../index.js');
const db = admin.firestore();
const authInstance = admin.auth();

const TEST_FILES = [
  'roles.test.js',
  'organization.test.js',
  'authorization.test.js',
  'platform.test.js',
  'provisioning.test.js',
  'billing-asaas.test.js',
  'billing-registry.test.js',
  'callable-cross-tenant.test.js',
  'jobs-isolation.test.js',
  'auction-isolation.test.js',
];

let passed = 0;
let failed = 0;
const failures = [];

async function t(description, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  } catch (err) {
    failed++;
    failures.push({ description, err });
    console.log(`  \x1b[31m✘\x1b[0m ${description}`);
    console.log(`    ${err.message}`);
  }
}

(async () => {
  for (const file of TEST_FILES) {
    console.log(`\n${file}`);
    const run = require(path.join(__dirname, file));
    await run({ db, authInstance, fns, t });
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed (${passed + failed} total)`);

  if (failed > 0) {
    console.log('\nFalhas:');
    failures.forEach(({ description, err }) => console.log(`  - ${description}: ${err.message}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Erro fatal no runner de testes:', err);
  process.exit(1);
});
