// functions/test/membershipCard.test.js — Carteirinha Digital do Associado.
// Cobre a lógica pura de status (functions/lib/membershipCard.js) e as duas
// Cloud Functions reais (ensureMembershipCardToken/verifyMembershipCard) via
// .run(data, context), sem emulador de Functions — mesmo padrão de
// callable-cross-tenant.test.js.
const assert = require('assert');
const { seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { computeCardStatus } = require('../lib/membershipCard');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: { uid } });
  const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

  /* ===================== computeCardStatus (lógica pura) ===================== */

  await t('computeCardStatus: ativo + activeUntil no futuro → válido', () => {
    const r = computeCardStatus({ ativo: true, activeUntil: inDays(10) });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.reason, 'ativo');
  });

  await t('computeCardStatus: ativo:false invalida na hora, mesmo com activeUntil no futuro (desativação administrativa)', () => {
    const r = computeCardStatus({ ativo: false, activeUntil: inDays(30) });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'desativado');
  });

  await t('computeCardStatus: ativo + activeUntil no passado → inválido (expirado)', () => {
    const r = computeCardStatus({ ativo: true, activeUntil: inDays(-1) });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'expirado');
  });

  await t('computeCardStatus: autocancelamento (ativo permanece true) dentro de activeUntil → válido', () => {
    // cancelMySubscription nunca toca em `ativo` — só assinaturaCanceladaPeloAssociado.
    const r = computeCardStatus({ ativo: true, activeUntil: inDays(5), assinaturaCanceladaPeloAssociado: true });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.reason, 'ativo');
  });

  await t('computeCardStatus: sem activeUntil nenhum → inválido (expirado)', () => {
    const r = computeCardStatus({ ativo: true, activeUntil: null });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'expirado');
  });

  /* ===================== ensureMembershipCardToken ===================== */

  await seedOrganization(db, { id: 'mc_org_a', nome: 'Organização A' });
  await seedOrganization(db, { id: 'mc_org_b', nome: 'Organização B' });
  await db.collection('organizations').doc('mc_org_a').collection('public').doc('branding').set({
    nome: 'Organização A', nomeCurto: 'Org A', logoUrl: 'https://example.com/logo-a.png',
  });

  await seedUser(db, authInstance, { uid: 'mc_assoc_ativo', cpf: '32111111101', orgId: 'mc_org_a', role: 'associado', nome: 'Associado Ativo', extra: { categoriaAssociado: 'normal' } });
  await db.collection('users').doc('mc_assoc_ativo').collection('finance').doc('summary').set({ activeUntil: inDays(20) });

  await t('ensureMembershipCardToken: exige autenticação', async () => {
    await assertRejectsWithCode(() => fns.ensureMembershipCardToken.run({}, { auth: null }), 'unauthenticated');
  });

  await t('ensureMembershipCardToken: cria token na primeira chamada', async () => {
    const res = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_ativo'));
    assert.ok(res.token && typeof res.token === 'string' && res.token.length >= 32);
  });

  await t('ensureMembershipCardToken: idempotente — segunda chamada devolve o MESMO token', async () => {
    const first = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_ativo'));
    const second = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_ativo'));
    assert.strictEqual(first.token, second.token);
  });

  await t('ensureMembershipCardToken: grava o índice reverso hash(token) → uid/orgId', async () => {
    const res = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_ativo'));
    const { hashToken } = require('../lib/membershipCard');
    const idxSnap = await db.collection('membershipCardTokens').doc(hashToken(res.token)).get();
    assert.ok(idxSnap.exists);
    assert.strictEqual(idxSnap.data().uid, 'mc_assoc_ativo');
    assert.strictEqual(idxSnap.data().orgId, 'mc_org_a');
  });

  /* ===================== verifyMembershipCard ===================== */

  await t('verifyMembershipCard: exige token', async () => {
    await assertRejectsWithCode(() => fns.verifyMembershipCard.run({}, {}), 'invalid-argument');
  });

  await t('verifyMembershipCard: token inexistente → not_found, sem lançar erro', async () => {
    const res = await fns.verifyMembershipCard.run({ token: 'token-que-nao-existe' }, {});
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, 'not_found');
  });

  await t('verifyMembershipCard: associado ativo → válido, com branding do tenant e dados mínimos (LGPD)', async () => {
    const { token } = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_ativo'));
    const res = await fns.verifyMembershipCard.run({ token }, {});
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.reason, 'ativo');
    assert.strictEqual(res.nome, 'Associado Ativo');
    assert.strictEqual(res.tenantNome, 'Org A');
    assert.strictEqual(res.tenantLogoUrl, 'https://example.com/logo-a.png');
    // Minimização: nunca CPF/telefone/e-mail/dado financeiro no payload.
    for (const key of ['cpf', 'telefone', 'email', 'asaasId', 'balance']) {
      assert.ok(!(key in res), `payload de verifyMembershipCard não deveria conter "${key}"`);
    }
  });

  await t('verifyMembershipCard: desativado pelo admin (ativo:false) → inválido, mesmo com activeUntil no futuro', async () => {
    await seedUser(db, authInstance, { uid: 'mc_assoc_desativado', cpf: '32111111102', orgId: 'mc_org_a', role: 'associado', nome: 'Associado Desativado', ativo: false });
    await db.collection('users').doc('mc_assoc_desativado').collection('finance').doc('summary').set({ activeUntil: inDays(30) });

    const { token } = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_desativado'));
    const res = await fns.verifyMembershipCard.run({ token }, {});
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, 'desativado');
  });

  await t('verifyMembershipCard: autocancelamento dentro da vigência → válido', async () => {
    await seedUser(db, authInstance, { uid: 'mc_assoc_autocancel', cpf: '32111111103', orgId: 'mc_org_a', role: 'associado', nome: 'Associado Autocancelado' });
    await db.collection('users').doc('mc_assoc_autocancel').collection('finance').doc('summary').set({ activeUntil: inDays(3) });
    await db.collection('users').doc('mc_assoc_autocancel').update({ assinaturaCanceladaPeloAssociado: true, assinaturaCanceladaEm: new Date() });

    const { token } = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_autocancel'));
    const res = await fns.verifyMembershipCard.run({ token }, {});
    assert.strictEqual(res.valid, true);
  });

  await t('verifyMembershipCard: expirado (activeUntil no passado) → inválido', async () => {
    await seedUser(db, authInstance, { uid: 'mc_assoc_expirado', cpf: '32111111104', orgId: 'mc_org_a', role: 'associado', nome: 'Associado Expirado' });
    await db.collection('users').doc('mc_assoc_expirado').collection('finance').doc('summary').set({ activeUntil: inDays(-5) });

    const { token } = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_expirado'));
    const res = await fns.verifyMembershipCard.run({ token }, {});
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, 'expirado');
  });

  await t('verifyMembershipCard: carteirinha de outra organização não vaza branding errado (isolamento de dado)', async () => {
    await seedUser(db, authInstance, { uid: 'mc_assoc_org_b', cpf: '32111111105', orgId: 'mc_org_b', role: 'associado', nome: 'Associado Org B' });
    await db.collection('users').doc('mc_assoc_org_b').collection('finance').doc('summary').set({ activeUntil: inDays(10) });
    await db.collection('organizations').doc('mc_org_b').collection('public').doc('branding').set({ nome: 'Organização B', nomeCurto: 'Org B' });

    const { token } = await fns.ensureMembershipCardToken.run({}, ctx('mc_assoc_org_b'));
    const res = await fns.verifyMembershipCard.run({ token }, {});
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.tenantNome, 'Org B');
    assert.notStrictEqual(res.tenantNome, 'Org A');
  });
};
