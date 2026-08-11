// Testa lib/platform.js e as 4 Cloud Functions da Fase 3.2 — o plano de
// identidade de PLATAFORMA (equipe da Serafim Technologies), separado do
// plano de ORGANIZAÇÃO (authorization.test.js). O achado central desta fase:
// um Platform Admin nunca tem orgId, um Organization Master nunca tem doc em
// platformAdmins — os dois planos precisam ser mutuamente cegos um ao outro.
const assert = require('assert');
const { createPlatformResolver, createPlatformAuthorizationHelpers } = require('../lib/platform');
const { seedOrganization, seedUser, seedPlatformAdmin } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const platformResolver = createPlatformResolver({ db });
  const platformAuth = createPlatformAuthorizationHelpers({ platformResolver });
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  /* =======================================================================
     migratePlatformAdmins — bootstrap de uso único. PRECISA rodar ANTES de
     qualquer seed de platformAdmins/{uid} nesta suíte: a partir da Fase 3.6
     (patch de segurança), a function só aceita chamada enquanto a coleção
     platformAdmins estiver genuinamente vazia — fecha de vez a superfície
     que, encadeada com o auto-cadastro corrigido em firestore.rules,
     permitia escalar de anônimo até Platform Owner.
     ======================================================================= */

  await seedOrganization(db, { id: 'plat_migra_org', nome: 'Org da Migração' });
  await seedUser(db, authInstance, { uid: 'plat_legado_master', cpf: '61111111199', orgId: 'plat_migra_org', role: 'Master' });

  await t('migratePlatformAdmins: caller sem doc em users/ (nem role master nenhum) é rejeitado', async () => {
    await assertRejectsWithCode(
      () => fns.migratePlatformAdmins.run({}, ctx('plat_uid_sem_doc_nenhum')),
      'permission-denied'
    );
  });

  await t('migratePlatformAdmins: migra conta master legada pra platformAdmins com role owner', async () => {
    const result = await fns.migratePlatformAdmins.run({}, ctx('plat_legado_master'));
    const migrated = result.results.find((r) => r.uid === 'plat_legado_master');
    assert.strictEqual(migrated.action, 'migrado');

    const platDoc = await db.collection('platformAdmins').doc('plat_legado_master').get();
    assert.strictEqual(platDoc.data().role, 'owner');

    const oldDoc = await db.collection('users').doc('plat_legado_master').get();
    assert.strictEqual(oldDoc.data().role, 'migrado_para_platform_admins', 'campo role antigo deveria ser neutralizado, não apagado');
    assert.ok(oldDoc.exists, 'doc antigo não deveria ser apagado (não-destrutivo)');
  });

  await t('CRÍTICO: depois do primeiro bootstrap, NENHUMA chamada é mais aceita — nem de outra conta master legítima e ainda não migrada', async () => {
    // plat_legado_master_2 só é criada AGORA, depois do 1º bootstrap —
    // simula uma conta master legada que "apareceu depois" (ex.: uma
    // migração de dados incompleta). Antes do patch de segurança isso teria
    // sido migrado com sucesso (era o cenário de "rodar de novo pra varrer
    // quem ficou de fora"). Agora platformAdmins já não está mais vazia (o
    // teste anterior colocou plat_legado_master lá), então a function se
    // recusa a rodar de novo, ponto final.
    await seedUser(db, authInstance, { uid: 'plat_legado_master_2', cpf: '61111111198', orgId: 'plat_migra_org', role: 'Master' });
    await assertRejectsWithCode(
      () => fns.migratePlatformAdmins.run({}, ctx('plat_legado_master_2')),
      'failed-precondition'
    );
    const platDoc = await db.collection('platformAdmins').doc('plat_legado_master_2').get();
    assert.strictEqual(platDoc.exists, false, 'conta não migrada deveria permanecer não migrada — bootstrap fechado de vez');
  });

  /* =======================================================================
     A partir daqui, platformAdmins já não está mais vazia (de propósito) —
     o resto da suíte usa contas seedadas diretamente, nunca mais passando
     pelo mecanismo de bootstrap.
     ======================================================================= */

  await seedPlatformAdmin(db, authInstance, { uid: 'plat_owner_1', email: 'plat_owner_1@teste.local', role: 'owner' });
  await seedPlatformAdmin(db, authInstance, { uid: 'plat_owner_2', email: 'plat_owner_2@teste.local', role: 'owner' });
  await seedPlatformAdmin(db, authInstance, { uid: 'plat_admin_1', email: 'plat_admin_1@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'plat_operator_1', email: 'plat_operator_1@teste.local', role: 'operator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'plat_inactive_1', email: 'plat_inactive_1@teste.local', role: 'administrator', ativo: false });

  await seedOrganization(db, { id: 'plat_org_a', nome: 'Org A' });
  await seedUser(db, authInstance, { uid: 'plat_org_master_a', cpf: '61111111101', orgId: 'plat_org_a', role: 'Master' });

  /* =======================================================================
     lib/platform.js — resolver e guardas de papel
     ======================================================================= */

  await t('resolvePlatformAdmin lança not-found pra uid sem doc em platformAdmins', async () => {
    await assertRejectsWithCode(() => platformResolver.resolvePlatformAdmin('nunca_existiu'), 'not-found');
  });

  await t('resolvePlatformAdmin lança failed-precondition pra conta desativada', async () => {
    await assertRejectsWithCode(() => platformResolver.resolvePlatformAdmin('plat_inactive_1'), 'failed-precondition');
  });

  await t('resolvePlatformAdmin resolve role corretamente pros 3 papéis', async () => {
    assert.strictEqual((await platformResolver.resolvePlatformAdmin('plat_owner_1')).role, 'owner');
    assert.strictEqual((await platformResolver.resolvePlatformAdmin('plat_admin_1')).role, 'administrator');
    assert.strictEqual((await platformResolver.resolvePlatformAdmin('plat_operator_1')).role, 'operator');
  });

  await t('requirePlatformStaff lança unauthenticated sem context.auth', async () => {
    await assertRejectsWithCode(() => platformAuth.requirePlatformStaff(ctx(null)), 'unauthenticated');
  });

  await t('requirePlatformAdministrator PERMITE administrator e owner, BLOQUEIA operator', async () => {
    await platformAuth.requirePlatformAdministrator(ctx('plat_admin_1'));
    await platformAuth.requirePlatformAdministrator(ctx('plat_owner_1'));
    await assertRejectsWithCode(() => platformAuth.requirePlatformAdministrator(ctx('plat_operator_1')), 'permission-denied');
  });

  await t('requirePlatformOwner PERMITE só owner, BLOQUEIA administrator e operator', async () => {
    await platformAuth.requirePlatformOwner(ctx('plat_owner_1'));
    await assertRejectsWithCode(() => platformAuth.requirePlatformOwner(ctx('plat_admin_1')), 'permission-denied');
    await assertRejectsWithCode(() => platformAuth.requirePlatformOwner(ctx('plat_operator_1')), 'permission-denied');
  });

  /* =======================================================================
     Isolamento cross-boundary — o ponto central da Fase 3.2
     ======================================================================= */

  await t('CRÍTICO: Platform Admin (sem orgId nenhum) é rejeitado por função org-scoped', async () => {
    // resetUserPassword exige requireOrganizationMaster -> resolveOrganization(uid)
    // -> lê users/{uid}; um platform admin não tem doc lá.
    await assertRejectsWithCode(
      () => fns.resetUserPassword.run({ targetUid: 'plat_org_master_a', newPassword: 'abcdefgh12' }, ctx('plat_owner_1')),
      'not-found'
    );
  });

  await t('CRÍTICO: Organization Master (sem doc em platformAdmins) é rejeitado por função platform-only', async () => {
    await assertRejectsWithCode(
      () => fns.createPlatformAdmin.run({ email: 'x@teste.local', nome: 'X', role: 'operator' }, ctx('plat_org_master_a')),
      'not-found'
    );
  });

  /* =======================================================================
     createPlatformAdmin — administrator só cria operator; owner cria qualquer papel
     ======================================================================= */

  await t('createPlatformAdmin: operator não tem acesso nenhum (nem pra criar operator)', async () => {
    await assertRejectsWithCode(
      () => fns.createPlatformAdmin.run({ email: 'novo1@teste.local', nome: 'Novo', role: 'operator' }, ctx('plat_operator_1')),
      'permission-denied'
    );
  });

  await t('createPlatformAdmin: administrator PODE criar operator', async () => {
    const result = await fns.createPlatformAdmin.run({ email: 'operador.novo@teste.local', nome: 'Operador Novo', role: 'operator' }, ctx('plat_admin_1'));
    assert.ok(result.uid);
    const doc = await db.collection('platformAdmins').doc(result.uid).get();
    assert.strictEqual(doc.data().role, 'operator');
    assert.strictEqual(doc.data().createdBy, 'plat_admin_1');
  });

  await t('createPlatformAdmin: administrator NÃO PODE criar administrator (escalonamento)', async () => {
    await assertRejectsWithCode(
      () => fns.createPlatformAdmin.run({ email: 'admin.novo@teste.local', nome: 'Admin Novo', role: 'administrator' }, ctx('plat_admin_1')),
      'permission-denied'
    );
  });

  await t('createPlatformAdmin: administrator NÃO PODE criar owner (escalonamento)', async () => {
    await assertRejectsWithCode(
      () => fns.createPlatformAdmin.run({ email: 'owner.novo@teste.local', nome: 'Owner Novo', role: 'owner' }, ctx('plat_admin_1')),
      'permission-denied'
    );
  });

  await t('createPlatformAdmin: owner PODE criar qualquer papel, inclusive owner', async () => {
    const result = await fns.createPlatformAdmin.run({ email: 'owner.criado.por.owner@teste.local', nome: 'Owner 3', role: 'owner' }, ctx('plat_owner_1'));
    const doc = await db.collection('platformAdmins').doc(result.uid).get();
    assert.strictEqual(doc.data().role, 'owner');
  });

  await t('createPlatformAdmin: e-mail já usado retorna already-exists', async () => {
    await assertRejectsWithCode(
      () => fns.createPlatformAdmin.run({ email: 'plat_operator_1@teste.local', nome: 'Duplicado', role: 'operator' }, ctx('plat_owner_1')),
      'already-exists'
    );
  });

  /* =======================================================================
     setPlatformAdminStatus — ativar/desativar
     ======================================================================= */

  await t('setPlatformAdminStatus: operator não tem acesso', async () => {
    await assertRejectsWithCode(
      () => fns.setPlatformAdminStatus.run({ uid: 'plat_admin_1', ativo: false }, ctx('plat_operator_1')),
      'permission-denied'
    );
  });

  await t('setPlatformAdminStatus: administrator NÃO PODE desativar outro administrator', async () => {
    await seedPlatformAdmin(db, authInstance, { uid: 'plat_admin_alvo', email: 'plat_admin_alvo@teste.local', role: 'administrator' });
    await assertRejectsWithCode(
      () => fns.setPlatformAdminStatus.run({ uid: 'plat_admin_alvo', ativo: false }, ctx('plat_admin_1')),
      'permission-denied'
    );
  });

  await t('setPlatformAdminStatus: administrator PODE desativar/reativar operator', async () => {
    await seedPlatformAdmin(db, authInstance, { uid: 'plat_operator_alvo', email: 'plat_operator_alvo@teste.local', role: 'operator' });
    await fns.setPlatformAdminStatus.run({ uid: 'plat_operator_alvo', ativo: false }, ctx('plat_admin_1'));
    let doc = await db.collection('platformAdmins').doc('plat_operator_alvo').get();
    assert.strictEqual(doc.data().ativo, false);

    await fns.setPlatformAdminStatus.run({ uid: 'plat_operator_alvo', ativo: true }, ctx('plat_admin_1'));
    doc = await db.collection('platformAdmins').doc('plat_operator_alvo').get();
    assert.strictEqual(doc.data().ativo, true);
  });

  await t('setPlatformAdminStatus: não é possível alterar o próprio status', async () => {
    await assertRejectsWithCode(
      () => fns.setPlatformAdminStatus.run({ uid: 'plat_owner_1', ativo: false }, ctx('plat_owner_1')),
      'invalid-argument'
    );
  });

  await t('setPlatformAdminStatus: desativar um owner quando existe outro owner ativo funciona normalmente', async () => {
    // plat_owner_1 e plat_owner_2 são os únicos owners ativos até aqui — desativar
    // um deles pelo outro é uma operação legítima (não é o último).
    await fns.setPlatformAdminStatus.run({ uid: 'plat_owner_2', ativo: false }, ctx('plat_owner_1'));
    const doc = await db.collection('platformAdmins').doc('plat_owner_2').get();
    assert.strictEqual(doc.data().ativo, false);
    // restaura o estado pros testes seguintes
    await db.collection('platformAdmins').doc('plat_owner_2').update({ ativo: true });
  });

  // NOTA: a guarda de "não deixar zero owners ativos" em setPlatformAdminStatus/
  // setPlatformAdminRole (index.js) é, na prática, inalcançável através de
  // qualquer combinação de chamadas legítimas — dado que (a) só um owner pode
  // agir sobre outro owner (administrator só toca operator) e (b) auto-ação
  // é sempre bloqueada antes mesmo de chegar nessa checagem, o único owner
  // remanescente nunca consegue ser o alvo de si mesmo. Mantida mesmo assim
  // como defesa em profundidade (ex.: um bug futuro no bloqueio de auto-ação
  // não deixaria a plataforma sem nenhum owner) — documentado aqui em vez de
  // fingir um teste que force um caminho que o próprio modelo de permissão
  // já torna impossível.

  /* =======================================================================
     setPlatformAdminRole — owner apenas
     ======================================================================= */

  await t('setPlatformAdminRole: administrator NÃO tem acesso (só owner)', async () => {
    await assertRejectsWithCode(
      () => fns.setPlatformAdminRole.run({ uid: 'plat_operator_1', newRole: 'administrator' }, ctx('plat_admin_1')),
      'permission-denied'
    );
  });

  await t('setPlatformAdminRole: owner PODE promover operator a administrator', async () => {
    await seedPlatformAdmin(db, authInstance, { uid: 'plat_promovivel', email: 'plat_promovivel@teste.local', role: 'operator' });
    await fns.setPlatformAdminRole.run({ uid: 'plat_promovivel', newRole: 'administrator' }, ctx('plat_owner_1'));
    const doc = await db.collection('platformAdmins').doc('plat_promovivel').get();
    assert.strictEqual(doc.data().role, 'administrator');
  });

  await t('setPlatformAdminRole: não é possível alterar o próprio papel', async () => {
    await assertRejectsWithCode(
      () => fns.setPlatformAdminRole.run({ uid: 'plat_owner_1', newRole: 'administrator' }, ctx('plat_owner_1')),
      'invalid-argument'
    );
  });

  await t('setPlatformAdminRole: rebaixar um owner quando existe outro owner ativo funciona normalmente', async () => {
    // plat_owner_1 e plat_owner_2 são os 2 únicos owners ativos neste ponto —
    // rebaixar um deles pelo outro é legítimo (não é o último). A mesma
    // inalcançabilidade do guard de "zero owners" documentada acima em
    // setPlatformAdminStatus se aplica aqui, pelo mesmo motivo.
    await fns.setPlatformAdminRole.run({ uid: 'plat_owner_2', newRole: 'administrator' }, ctx('plat_owner_1'));
    const doc = await db.collection('platformAdmins').doc('plat_owner_2').get();
    assert.strictEqual(doc.data().role, 'administrator');
  });

  /* =======================================================================
     deletePlatformAdmin — exclusão definitiva (Firestore + Auth), diferente
     de setPlatformAdminStatus (soft delete). Mesma escalada de privilégio de
     createPlatformAdmin/setPlatformAdminStatus: administrator só exclui
     operator, owner exclui qualquer um.
     ======================================================================= */

  await t('deletePlatformAdmin: operator não tem acesso', async () => {
    await assertRejectsWithCode(
      () => fns.deletePlatformAdmin.run({ uid: 'plat_admin_1' }, ctx('plat_operator_1')),
      'permission-denied'
    );
  });

  await t('deletePlatformAdmin: administrator NÃO PODE excluir outro administrator', async () => {
    await seedPlatformAdmin(db, authInstance, { uid: 'plat_admin_para_excluir', email: 'plat_admin_para_excluir@teste.local', role: 'administrator' });
    await assertRejectsWithCode(
      () => fns.deletePlatformAdmin.run({ uid: 'plat_admin_para_excluir' }, ctx('plat_admin_1')),
      'permission-denied'
    );
  });

  await t('deletePlatformAdmin: administrator PODE excluir operator', async () => {
    await seedPlatformAdmin(db, authInstance, { uid: 'plat_operator_para_excluir', email: 'plat_operator_para_excluir@teste.local', role: 'operator' });
    await fns.deletePlatformAdmin.run({ uid: 'plat_operator_para_excluir' }, ctx('plat_admin_1'));
    const doc = await db.collection('platformAdmins').doc('plat_operator_para_excluir').get();
    assert.strictEqual(doc.exists, false);
  });

  await t('deletePlatformAdmin: não é possível excluir a própria conta', async () => {
    await assertRejectsWithCode(
      () => fns.deletePlatformAdmin.run({ uid: 'plat_owner_1' }, ctx('plat_owner_1')),
      'invalid-argument'
    );
  });

  await t('deletePlatformAdmin: uid inexistente retorna not-found', async () => {
    await assertRejectsWithCode(
      () => fns.deletePlatformAdmin.run({ uid: 'nunca_existiu_platform_admin' }, ctx('plat_owner_1')),
      'not-found'
    );
  });

  // NOTA: mesma inalcançabilidade documentada em setPlatformAdminStatus/
  // setPlatformAdminRole se aplica à guarda de "não deixar zero owners
  // ativos" aqui — só um owner pode agir sobre outro owner e auto-ação é
  // sempre bloqueada antes dessa checagem, então o último owner remanescente
  // nunca pode ser alvo de si mesmo. Mantida como defesa em profundidade.
};
