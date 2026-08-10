// functions/test/rules.test.js — testes de verdade das Firestore Rules (Fase 3.2).
//
// Diferente do resto de functions/test/ (que usa firebase-admin, que IGNORA
// Rules por completo — Admin SDK sempre bypassa): aqui usamos
// @firebase/rules-unit-testing, que aplica as Rules de verdade contra um
// client autenticado exatamente como o navegador de um usuário real faria.
// A reescrita desta fase é justamente nas Rules — testar só via Admin SDK
// deixaria essa mudança inteira sem cobertura nenhuma.
//
// Roda separado do resto (`npm run test:rules`), contra o MESMO emulador
// Firestore já usado por `npm test`, mas num projectId isolado — não
// compartilha dado nenhum com functions/test/*.test.js.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, query, where } = require('firebase/firestore');

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
  const rulesPath = path.join(__dirname, '../../firestore.rules');
  const testEnv = await initializeTestEnvironment({
    projectId: 'rules-test-fase3-2',
    firestore: {
      rules: fs.readFileSync(rulesPath, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'organizations/rt_org_a'), { nome: 'Org A', ativo: true });
    await setDoc(doc(db, 'organizations/rt_org_b'), { nome: 'Org B', ativo: true });

    await setDoc(doc(db, 'users/rt_master_a'), { role: 'Master', orgId: 'rt_org_a', nome: 'Master A' });
    await setDoc(doc(db, 'users/rt_admin_a'), { role: 'Admin', orgId: 'rt_org_a', nome: 'Admin A' });
    await setDoc(doc(db, 'users/rt_viewer_a'), { role: 'Admin View', orgId: 'rt_org_a', nome: 'Viewer A' });
    await setDoc(doc(db, 'users/rt_associado_a'), { role: 'associado', orgId: 'rt_org_a', nome: 'Associado A' });
    await setDoc(doc(db, 'users/rt_admin_b'), { role: 'Admin', orgId: 'rt_org_b', nome: 'Admin B' });

    await setDoc(doc(db, 'platformAdmins/rt_platform_owner'), { role: 'owner', ativo: true, nome: 'Owner' });
    await setDoc(doc(db, 'platformAdmins/rt_platform_operator'), { role: 'operator', ativo: true, nome: 'Operator' });

    await setDoc(doc(db, 'provisioningRuns/rt_run_1'), { orgId: 'rt_org_a', status: 'completed', requestedBy: 'rt_platform_owner' });

    await setDoc(doc(db, 'domains/rt-clube-a.com.br'), { orgId: 'rt_org_a', tipo: 'primario', status: 'verificado' });
    await setDoc(doc(db, 'organizations/rt_org_a/public/branding'), { nome: 'Org A', corPrimaria: '#111279' });
  });

  const ctxFor = (uid) => testEnv.authenticatedContext(uid).firestore();
  const anon = () => testEnv.unauthenticatedContext().firestore();

  console.log('\nrules.test.js — users/{userId} (Fase 3.2: leitura/escrita separadas, role só via Master)');

  await t('escrita no campo role: Organization Administrator (não master) é BLOQUEADA — mudança desta fase', async () => {
    const db = ctxFor('rt_admin_a');
    await assertFails(updateDoc(doc(db, 'users/rt_associado_a'), { role: 'operador' }));
  });

  await t('escrita no campo role: Organization Master é PERMITIDA', async () => {
    const db = ctxFor('rt_master_a');
    await assertSucceeds(updateDoc(doc(db, 'users/rt_associado_a'), { role: 'operador' }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users/rt_associado_a'), { role: 'associado', orgId: 'rt_org_a', nome: 'Associado A' });
    });
  });

  await t('escrita em campo comum (não-role): Organization Administrator continua podendo', async () => {
    const db = ctxFor('rt_admin_a');
    await assertSucceeds(updateDoc(doc(db, 'users/rt_associado_a'), { telefone: '31999999999' }));
  });

  await t('leitura (get): Organization Viewer PODE ler um usuário da própria org — lacuna corrigida nesta fase', async () => {
    const db = ctxFor('rt_viewer_a');
    await assertSucceeds(getDoc(doc(db, 'users/rt_associado_a')));
  });

  await t('escrita: Organization Viewer NÃO PODE escrever em usuário nenhum', async () => {
    const db = ctxFor('rt_viewer_a');
    await assertFails(updateDoc(doc(db, 'users/rt_associado_a'), { nome: 'Tentativa de escrita' }));
  });

  await t('leitura cross-tenant: admin da org B NÃO PODE ler usuário da org A', async () => {
    const db = ctxFor('rt_admin_b');
    await assertFails(getDoc(doc(db, 'users/rt_associado_a')));
  });

  await t('Platform Staff PODE ler (list) usuários de qualquer organização', async () => {
    const db = ctxFor('rt_platform_operator');
    const snap = await assertSucceeds(getDocs(query(collection(db, 'users'), where('orgId', '==', 'rt_org_a'))));
    assert.ok(snap.size >= 1);
  });

  await t('Platform Staff NÃO PODE escrever em usuário de organização nenhuma — bypass de escrita removido nesta fase', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertFails(updateDoc(doc(db, 'users/rt_associado_a'), { nome: 'Plataforma tentando escrever' }));
  });

  console.log('\nrules.test.js — platformAdmins/{uid} (nova coleção)');

  await t('platformAdmins: escrita direta do cliente é SEMPRE bloqueada, mesmo pra owner — só Cloud Functions', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertFails(setDoc(doc(db, 'platformAdmins/novo_uid'), { role: 'operator', ativo: true }));
  });

  await t('platformAdmins: qualquer membro da equipe de plataforma PODE ler o roster', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertSucceeds(getDoc(doc(db, 'platformAdmins/rt_platform_owner')));
  });

  await t('platformAdmins: Organization Master NÃO PODE ler o roster de plataforma — planos não se enxergam', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(getDoc(doc(db, 'platformAdmins/rt_platform_owner')));
  });

  await t('platformAdmins: usuário não-logado NÃO PODE ler nada', async () => {
    await assertFails(getDoc(doc(anon(), 'platformAdmins/rt_platform_owner')));
  });

  console.log('\nrules.test.js — organizations/systemConfig (bypass de plataforma antigo removido)');

  await t('organizations: Organization Master NÃO PODE mais listar todas as orgs — isMaster() cross-tenant não existe mais', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(getDocs(collection(db, 'organizations')));
  });

  await t('organizations: Platform Staff PODE listar todas as orgs', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertSucceeds(getDocs(collection(db, 'organizations')));
  });

  await t('organizations: create direto do cliente é SEMPRE bloqueado, mesmo pra Platform Owner — Fase 3.3, só provisionOrganization cria', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertFails(setDoc(doc(db, 'organizations/rt_org_nova_direto'), { nome: 'Tentativa direta', ativo: true }));
  });

  console.log('\nrules.test.js — provisioningRuns/{runId} (Fase 3.3, nova coleção)');

  await t('provisioningRuns: Platform Staff PODE ler', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertSucceeds(getDoc(doc(db, 'provisioningRuns/rt_run_1')));
  });

  await t('provisioningRuns: Organization Master NÃO PODE ler — é auditoria de plataforma, não de organização', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(getDoc(doc(db, 'provisioningRuns/rt_run_1')));
  });

  await t('provisioningRuns: escrita direta do cliente é SEMPRE bloqueada, mesmo pra owner — só Cloud Functions', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertFails(setDoc(doc(db, 'provisioningRuns/rt_run_novo'), { orgId: 'rt_org_a', status: 'running' }));
  });

  await t('organizations: Platform Operator NÃO PODE escrever (só administrator/owner)', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), { nome: 'Renomeada' }));
  });

  await t('organizations: Platform Owner PODE escrever', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertSucceeds(updateDoc(doc(db, 'organizations/rt_org_a'), { nome: 'Org A Renomeada' }));
  });

  await t('systemConfig: Platform Operator PODE ler, mas NÃO PODE escrever', async () => {
    const db = ctxFor('rt_platform_operator');
    await assertSucceeds(getDoc(doc(db, 'systemConfig/global')));
    await assertFails(setDoc(doc(db, 'systemConfig/global'), { nomePlataforma: 'X' }, { merge: true }));
  });

  console.log('\nrules.test.js — domains/{hostname} + organizations/{orgId}/public/branding (Fase 3.5)');

  await t('organizations/{orgId} completo: leitura anônima continua BLOQUEADA — a lacuna que a projeção pública resolve não pode ser reaberta por engano', async () => {
    const db = anon();
    await assertFails(getDoc(doc(db, 'organizations/rt_org_a')));
  });

  await t('domains: leitura (get) é pública, mesmo sem autenticação — precisa resolver antes de qualquer login', async () => {
    const db = anon();
    await assertSucceeds(getDoc(doc(db, 'domains/rt-clube-a.com.br')));
  });

  await t('domains: list é restrito a Platform Staff', async () => {
    await assertFails(getDocs(collection(anon(), 'domains')));
    await assertFails(getDocs(collection(ctxFor('rt_master_a'), 'domains')));
    await assertSucceeds(getDocs(collection(ctxFor('rt_platform_operator'), 'domains')));
  });

  await t('domains: escrita direta do cliente é SEMPRE bloqueada, mesmo pra Platform Owner — só setOrganizationDomains (Cloud Function)', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertFails(setDoc(doc(db, 'domains/rt-outro.com.br'), { orgId: 'rt_org_a', tipo: 'primario', status: 'verificado' }));
  });

  await t('organizations/{orgId}/public/branding: leitura (get) é pública, mesmo sem autenticação', async () => {
    const db = anon();
    await assertSucceeds(getDoc(doc(db, 'organizations/rt_org_a/public/branding')));
  });

  await t('organizations/{orgId}/public/branding: list é sempre bloqueado, até pra Platform Staff — evita enumeração', async () => {
    await assertFails(getDocs(collection(ctxFor('rt_platform_owner'), 'organizations/rt_org_a/public')));
  });

  await t('organizations/{orgId}/public/branding: escrita direta do cliente é SEMPRE bloqueada, mesmo pra Platform Owner — só o trigger onOrganizationWritten', async () => {
    const db = ctxFor('rt_platform_owner');
    await assertFails(setDoc(doc(db, 'organizations/rt_org_a/public/branding'), { nome: 'Tentativa direta' }, { merge: true }));
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
  console.error('Erro fatal no runner de testes de Rules:', err);
  process.exit(1);
});
