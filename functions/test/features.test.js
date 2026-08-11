// Testa lib/features.js — resolução de Feature Flags (Fase 3.8).
// Primeiro bloco: resolveFlag/isInRolloutBucket são funções PURAS, testadas
// sem Firestore nenhum (mesmo espírito de billing-registry.test.js). Segundo
// bloco: createFeatureService contra o emulador real, cobrindo o ciclo
// completo create→status→override→archive e a convergência de cache.
const assert = require('assert');
const { createFeatureService, resolveFlag, isInRolloutBucket } = require('../lib/features');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, t }) {
  // ---- resolveFlag: função pura ----

  await t('resolveFlag: flag inexistente (null) é fail-CLOSED (false) — oposto deliberado de modules.js', async () => {
    assert.strictEqual(resolveFlag(null, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: flag arquivada é sempre false, mesmo com status "on"', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'on', archived: true, overrides: {} }, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: status "off" é false pra qualquer organização sem override', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'off', overrides: {} }, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: status "on" é true pra qualquer organização sem override', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'on', overrides: {} }, { orgId: 'org_a' }), true);
  });

  await t('resolveFlag: override explícito true vence status "off"', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'off', overrides: { org_a: true } }, { orgId: 'org_a' }), true);
  });

  await t('resolveFlag: override explícito false vence status "on" (kill-switch por tenant)', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'on', overrides: { org_a: false } }, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: override de OUTRA organização não afeta esta', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'off', overrides: { org_b: true } }, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: environments restringe mesmo com status "on"', async () => {
    const flag = { key: 'x', status: 'on', overrides: {}, environments: ['sandbox'] };
    assert.strictEqual(resolveFlag(flag, { orgId: 'org_a', environment: 'production' }), false);
    assert.strictEqual(resolveFlag(flag, { orgId: 'org_a', environment: 'sandbox' }), true);
  });

  await t('resolveFlag: environments não bloqueia quando ausente/vazio (sem restrição)', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'on', overrides: {}, environments: null }, { orgId: 'org_a' }), true);
  });

  await t('resolveFlag: status "rollout" 0% nunca liga (sem override)', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'rollout', rolloutPercentage: 0, overrides: {} }, { orgId: 'org_a' }), false);
  });

  await t('resolveFlag: status "rollout" 100% sempre liga (sem override)', async () => {
    assert.strictEqual(resolveFlag({ key: 'x', status: 'rollout', rolloutPercentage: 100, overrides: {} }, { orgId: 'org_a' }), true);
  });

  await t('isInRolloutBucket: determinístico — mesma org+flag sempre no mesmo bucket', async () => {
    const a = isInRolloutBucket('org_determinismo', 'minha_flag', 50);
    const b = isInRolloutBucket('org_determinismo', 'minha_flag', 50);
    assert.strictEqual(a, b);
  });

  await t('isInRolloutBucket: orgId diferente pode cair em bucket diferente (distribuição, não igualdade forçada)', async () => {
    // Não afirma quais orgs caem dentro/fora (evita teste frágil) — só que a
    // função responde de forma binária e não lança erro pra várias entradas.
    for (let i = 0; i < 20; i++) {
      const result = isInRolloutBucket(`org_dist_${i}`, 'minha_flag', 50);
      assert.strictEqual(typeof result, 'boolean');
    }
  });

  await t('isInRolloutBucket: sem orgId é sempre false', async () => {
    assert.strictEqual(isInRolloutBucket(null, 'minha_flag', 100), false);
  });

  // ---- createFeatureService: contra o emulador real ----

  const service = createFeatureService({
    db,
    serverTimestamp: () => new Date(),
    deleteField: () => require('firebase-admin').firestore.FieldValue.delete(),
    collectionName: 'featureFlags_test', // isolado da coleção real, mesmo padrão de projectId isolado dos outros arquivos de teste
  });

  await t('createFlag: rejeita key fora do padrão snake_case', async () => {
    await assertRejectsWithCode(() => service.createFlag({ key: 'Minha Flag Inválida', createdBy: 'tester' }), 'invalid-argument');
  });

  await t('createFlag: cria com defaults seguros (status off, overrides vazio, nunca liga sozinha)', async () => {
    await service.createFlag({ key: 'feat_teste_ciclo', description: 'Flag de teste do ciclo completo', category: 'experiment', createdBy: 'tester' });
    const flag = await service.getFlag('feat_teste_ciclo');
    assert.strictEqual(flag.status, 'off');
    assert.deepStrictEqual(flag.overrides, {});
    assert.strictEqual(flag.archived, false);
  });

  await t('createFlag: chave duplicada rejeita com already-exists (idempotência de identidade, não de conteúdo)', async () => {
    await assertRejectsWithCode(() => service.createFlag({ key: 'feat_teste_ciclo', createdBy: 'tester' }), 'already-exists');
  });

  await t('isEnabled: flag nova (status off) é false pra qualquer organização', async () => {
    const enabled = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_qualquer' });
    assert.strictEqual(enabled, false);
  });

  await t('setStatus: liga globalmente e isEnabled reflete (após invalidar cache)', async () => {
    await service.setStatus('feat_teste_ciclo', 'on', { updatedBy: 'tester' });
    const enabled = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_qualquer' });
    assert.strictEqual(enabled, true);
  });

  await t('setStatus: rejeita rolloutPercentage fora de [0,100]', async () => {
    await assertRejectsWithCode(() => service.setStatus('feat_teste_ciclo', 'rollout', { rolloutPercentage: 150, updatedBy: 'tester' }), 'invalid-argument');
  });

  await t('setStatus: rejeita status desconhecido', async () => {
    await assertRejectsWithCode(() => service.setStatus('feat_teste_ciclo', 'ligado_de_vez', {}), 'invalid-argument');
  });

  await t('setStatus: flag inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(() => service.setStatus('feat_nao_existe', 'on', {}), 'not-found');
  });

  await t('setOverride: desliga só uma organização mesmo com status "on" (kill-switch pontual)', async () => {
    await service.setOverride('feat_teste_ciclo', 'org_bloqueada', false, { updatedBy: 'tester' });
    const bloqueada = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_bloqueada' });
    const outra = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_qualquer' });
    assert.strictEqual(bloqueada, false);
    assert.strictEqual(outra, true);
  });

  await t('setOverride: value=null remove a exceção, volta a seguir status', async () => {
    await service.setOverride('feat_teste_ciclo', 'org_bloqueada', null, { updatedBy: 'tester' });
    const agora = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_bloqueada' });
    assert.strictEqual(agora, true);
  });

  await t('resolveAll: devolve mapa com todas as flags não-arquivadas', async () => {
    await service.createFlag({ key: 'feat_teste_ciclo_2', createdBy: 'tester' });
    const flags = await service.resolveAll({ orgId: 'org_qualquer' });
    assert.strictEqual(flags.feat_teste_ciclo, true);
    assert.strictEqual(flags.feat_teste_ciclo_2, false);
  });

  await t('setArchived: flag arquivada some de resolveAll e isEnabled vira false', async () => {
    await service.setArchived('feat_teste_ciclo', true, { updatedBy: 'tester' });
    const enabled = await service.isEnabled('feat_teste_ciclo', { orgId: 'org_qualquer' });
    const flags = await service.resolveAll({ orgId: 'org_qualquer' });
    assert.strictEqual(enabled, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(flags, 'feat_teste_ciclo'), false);
  });

  // Limpeza — evita lixo persistente na coleção de teste entre execuções manuais.
  await db.collection('featureFlags_test').doc('feat_teste_ciclo').delete();
  await db.collection('featureFlags_test').doc('feat_teste_ciclo_2').delete();
};
