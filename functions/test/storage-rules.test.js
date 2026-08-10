// functions/test/storage-rules.test.js — testes de verdade das Storage
// Security Rules (Fase 3.4). Mesma ideia de rules.test.js (Firestore), mas
// pro serviço de Storage: aplica as regras de verdade contra um client
// autenticado, não Admin SDK (que ignora Rules por completo).
//
// Corrige a lacuna encontrada na Fase 3.3 e confirmada aqui: antes desta
// fase, tenants/{orgId}/cms/{categoria}/{arquivo} só checava
// isSignedIn()+isImage() — nunca comparava o {orgId} do caminho com a
// organização de quem estava enviando. Qualquer usuário autenticado podia
// gravar arquivo na pasta de QUALQUER organização.
//
// Depende de firestore.get() dentro de Storage Rules (leitura cross-service)
// — verificado empiricamente contra o emulador local antes de escrever a
// correção definitiva (ver Contexto do plano da Fase 3.4): funciona.
//
// Roda separado (`npm run test:storage-rules`), contra os MESMOS emuladores
// Firestore+Storage já usados por `npm run test:rules`, projectId isolado.

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes } = require('firebase/storage');

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

const FAKE_IMAGE = new Uint8Array([1, 2, 3, 4]);
const IMAGE_META = { contentType: 'image/png' };

(async () => {
  // IMPORTANTE, achado empírico: ao contrário de rules.test.js (Firestore
  // puro, onde um projectId isolado tipo "rules-test-fase3-2" funciona sem
  // problema), a chamada cross-service firestore.get() de dentro de uma
  // Storage Rule só resolveu corretamente contra o projectId REAL
  // ("clubecavalobonfim") no emulador local desta máquina — com um projectId
  // isolado, callerOrgId() sempre voltava vazio (toda escrita, mesmo na
  // própria organização, era negada). Verificado empiricamente antes de
  // escrever esta observação — não é suposição.
  const testEnv = await initializeTestEnvironment({
    projectId: 'clubecavalobonfim',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
    storage: {
      rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8'),
      host: '127.0.0.1', port: 9199,
    },
  });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/sr_user_a'), { role: 'admin', orgId: 'sr_org_a' });
    await setDoc(doc(db, 'users/sr_user_b'), { role: 'admin', orgId: 'sr_org_b' });
    await setDoc(doc(db, 'platformAdmins/sr_platform_admin'), { role: 'owner', ativo: true });
  });

  const storageFor = (uid) => testEnv.authenticatedContext(uid).storage();
  const anonStorage = () => testEnv.unauthenticatedContext().storage();

  console.log('\nstorage-rules.test.js — tenants/{orgId}/cms/{categoria}/{arquivo}');

  await t('usuário da própria organização PODE escrever no caminho da própria org', async () => {
    await assertSucceeds(uploadBytes(ref(storageFor('sr_user_a'), 'tenants/sr_org_a/cms/banners/teste.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('CRÍTICO: usuário da org A NÃO PODE escrever no caminho da org B — a lacuna da Fase 3.3', async () => {
    await assertFails(uploadBytes(ref(storageFor('sr_user_a'), 'tenants/sr_org_b/cms/banners/teste.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('conta de plataforma (sem orgId) NÃO PODE escrever em organização nenhuma', async () => {
    await assertFails(uploadBytes(ref(storageFor('sr_platform_admin'), 'tenants/sr_org_a/cms/banners/teste.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('usuário não-logado NÃO PODE escrever em organização nenhuma', async () => {
    await assertFails(uploadBytes(ref(anonStorage(), 'tenants/sr_org_a/cms/banners/teste.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('leitura continua pública (qualquer um, mesmo sem login)', async () => {
    await assertSucceeds(getBytes(ref(anonStorage(), 'tenants/sr_org_a/cms/banners/teste.png')));
  });

  console.log('\nstorage-rules.test.js — tenants/{orgId}/branding/{arquivo} (Fase 3.4, novo caminho)');

  await t('usuário da própria organização PODE enviar logo/favicon da própria org', async () => {
    await assertSucceeds(uploadBytes(ref(storageFor('sr_user_a'), 'tenants/sr_org_a/branding/logo.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('CRÍTICO: usuário da org A NÃO PODE enviar branding pra org B — mesma proteção do CMS', async () => {
    await assertFails(uploadBytes(ref(storageFor('sr_user_a'), 'tenants/sr_org_b/branding/logo.png'), FAKE_IMAGE, IMAGE_META));
  });

  await t('leitura de branding também é pública (logo precisa aparecer no site)', async () => {
    await assertSucceeds(getBytes(ref(anonStorage(), 'tenants/sr_org_a/branding/logo.png')));
  });

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed (${passed + failed} total)`);

  await testEnv.cleanup();

  if (failed > 0) {
    console.log('\nFalhas:');
    failures.forEach(({ description, err }) => console.log(`  - ${description}: ${err.message}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Erro fatal no runner de testes de Storage Rules:', err);
  process.exit(1);
});
