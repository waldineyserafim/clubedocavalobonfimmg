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

    await setDoc(doc(db, 'eventRegistrations/rt_reg_a'), { orgId: 'rt_org_a', eventoId: 'rt_evento_a', nome: 'Fulano', cpf: '11111111111', token: 'segredo-a' });
    await setDoc(doc(db, 'eventRegistrations/rt_reg_b'), { orgId: 'rt_org_b', eventoId: 'rt_evento_b', nome: 'Beltrano', cpf: '22222222222', token: 'segredo-b' });
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

  console.log('\nrules.test.js — organizations/{orgId}: self-service do Organization Master (Evolucao Multi-Tenant, Fase 4)');

  await t('organizations: Organization Master PODE alterar campos de negocio/identidade da PROPRIA organizacao', async () => {
    const db = ctxFor('rt_master_a');
    await assertSucceeds(updateDoc(doc(db, 'organizations/rt_org_a'), {
      telefone: '31900000000',
      whatsapp: '5531900000000',
      billing: { plans: [{ id: 'mensal', label: 'Mensal', cycle: 'MONTHLY', price: 42 }], mirimDiscountRatio: 0.6 },
      business: { classifieds: { pricePerDay: 2, minimumDays: 15 } },
      notificationEmails: ['financeiro@orga.exemplo'],
    }));
  });

  await t('organizations: Organization Admin (nao-Master) NAO PODE usar o mecanismo de self-service', async () => {
    const db = ctxFor('rt_admin_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), { telefone: '31911111111' }));
  });

  await t('organizations: Organization Master de OUTRA organizacao NAO PODE alterar esta - isolamento entre tenants', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_b'), { telefone: '31922222222' }));
  });

  await t('organizations: Organization Master NAO PODE alterar campos fora do allowlist (billingProvider)', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), { billingProvider: 'outro-provider' }));
  });

  await t('organizations: Organization Master NAO PODE alterar modulos contratados (plataforma controla)', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), { modules: { leiloes: true } }));
  });

  await t('organizations: Organization Master NAO PODE se auto-ativar/desativar', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), { ativo: false }));
  });

  await t('CRITICO: organizations: Organization Master NAO PODE alterar business.auction.commissionSistemaPct (comissao da PLATAFORMA)', async () => {
    const db = ctxFor('rt_master_a');
    await assertFails(updateDoc(doc(db, 'organizations/rt_org_a'), {
      business: { auction: { commissionSistemaPct: 0.5, commissionClubePct: 0.05 } },
    }));
  });

  await t('organizations: Organization Master PODE alterar business.auction.commissionClubePct mantendo commissionSistemaPct no valor ja gravado pela plataforma', async () => {
    const platformDb = ctxFor('rt_platform_owner');
    await assertSucceeds(updateDoc(doc(platformDb, 'organizations/rt_org_a'), {
      business: { auction: { commissionSistemaPct: 0.05, commissionClubePct: 0.05, minBidIncrementPct: 0.02 } },
    }));
    const masterDb = ctxFor('rt_master_a');
    await assertSucceeds(updateDoc(doc(masterDb, 'organizations/rt_org_a'), {
      business: { auction: { commissionSistemaPct: 0.05, commissionClubePct: 0.08, minBidIncrementPct: 0.03 } },
    }));
    await assertFails(updateDoc(doc(masterDb, 'organizations/rt_org_a'), {
      business: { auction: { commissionSistemaPct: 0.9, commissionClubePct: 0.08, minBidIncrementPct: 0.03 } },
    }));
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

  console.log('\nrules.test.js — users/{userId} create (PATCH CRÍTICO Fase 3.6)');

  await t('auto-cadastro: cria o próprio doc com role "associado" (fluxo real de signup.html) — PERMANECE FUNCIONANDO', async () => {
    const db = ctxFor('rt_novo_associado');
    await assertSucceeds(setDoc(doc(db, 'users/rt_novo_associado'), { role: 'associado', orgId: 'rt_org_a', nome: 'Novo Associado' }));
  });

  await t('auto-cadastro: cria o próprio doc com role "participanteLeilao" (fluxo real de leilão) — PERMANECE FUNCIONANDO', async () => {
    const db = ctxFor('rt_novo_participante');
    await assertSucceeds(setDoc(doc(db, 'users/rt_novo_participante'), { role: 'participanteLeilao', orgId: 'rt_org_a', nome: 'Novo Participante' }));
  });

  await t('CRÍTICO: auto-cadastro NÃO PODE se autopromover a "master" na criação — vulnerabilidade fechada', async () => {
    const db = ctxFor('rt_atacante_master');
    await assertFails(setDoc(doc(db, 'users/rt_atacante_master'), { role: 'master', orgId: 'rt_org_a', nome: 'Atacante' }));
  });

  await t('CRÍTICO: auto-cadastro NÃO PODE se autopromover a "admin" na criação', async () => {
    const db = ctxFor('rt_atacante_admin');
    await assertFails(setDoc(doc(db, 'users/rt_atacante_admin'), { role: 'admin', orgId: 'rt_org_a', nome: 'Atacante' }));
  });

  await t('auto-cadastro NÃO PODE inventar um orgId de organização inexistente', async () => {
    const db = ctxFor('rt_atacante_org_falsa');
    await assertFails(setDoc(doc(db, 'users/rt_atacante_org_falsa'), { role: 'associado', orgId: 'rt_org_nao_existe', nome: 'Atacante' }));
  });

  console.log('\nrules.test.js — eventRegistrations/{regId} (PATCH CRÍTICO Fase 3.6)');

  await t('get (1 doc por ID) continua público, mesmo sem login — fluxo real de event_comprovante.html PERMANECE FUNCIONANDO', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'eventRegistrations/rt_reg_a')));
  });

  await t('CRÍTICO: list (dump da coleção) sem login é BLOQUEADO — vulnerabilidade de vazamento de PII fechada', async () => {
    await assertFails(getDocs(collection(anon(), 'eventRegistrations')));
  });

  await t('CRÍTICO: list sem login continua bloqueado mesmo filtrando por orgId no client (o filtro é só cosmético sem a regra)', async () => {
    await assertFails(getDocs(query(collection(anon(), 'eventRegistrations'), where('orgId', '==', 'rt_org_a'))));
  });

  await t('admin da própria org PODE listar as inscrições da própria org — fluxo real de admin_inscricoes.html PERMANECE FUNCIONANDO', async () => {
    const db = ctxFor('rt_admin_a');
    const snap = await assertSucceeds(getDocs(query(collection(db, 'eventRegistrations'), where('orgId', '==', 'rt_org_a'))));
    assert.strictEqual(snap.size, 1);
    assert.strictEqual(snap.docs[0].id, 'rt_reg_a');
  });

  await t('admin de outra organização NÃO PODE listar inscrições de rt_org_a', async () => {
    const db = ctxFor('rt_admin_b');
    await assertFails(getDocs(query(collection(db, 'eventRegistrations'), where('orgId', '==', 'rt_org_a'))));
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
