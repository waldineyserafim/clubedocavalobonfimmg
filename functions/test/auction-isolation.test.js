// Testa o isolamento por organização do módulo de leilão (Fase 2C) — o
// achado central desta fase: auctionLots já carregava orgId desde jun/2026,
// mas nenhuma Cloud Function verificava organização antes de agir, e
// auctionSales/auctionPayments nunca recebiam o campo. placeBid não toca
// Secret Manager (é só Firestore) — testado de ponta a ponta, sucesso e
// bloqueio. gerarCobrancaLeilao/liberarRepasse: só o caminho bloqueado
// (mesma razão de callable-cross-tenant.test.js — evitar produção).
const assert = require('assert');
const { seedOrganization, seedUser } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  await seedOrganization(db, { id: 'auc_org_a', nome: 'Org A' });
  await seedOrganization(db, { id: 'auc_org_b', nome: 'Org B' });

  await seedUser(db, authInstance, { uid: 'auc_seller_a', cpf: '51111111101', orgId: 'auc_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'auc_bidder_a', cpf: '51111111102', orgId: 'auc_org_a', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'auc_bidder_b', cpf: '51111111103', orgId: 'auc_org_b', role: 'associado' });
  await seedUser(db, authInstance, { uid: 'auc_admin_a', cpf: '51111111104', orgId: 'auc_org_a', role: 'Admin' });
  await seedUser(db, authInstance, { uid: 'auc_admin_b', cpf: '51111111105', orgId: 'auc_org_b', role: 'Admin' });
  await seedUser(db, authInstance, { uid: 'auc_master_a', cpf: '51111111106', orgId: 'auc_org_a', role: 'Master' });

  const admin = require('firebase-admin');
  const lotRef = await db.collection('auctionLots').add({
    orgId: 'auc_org_a', sellerUid: 'auc_seller_a', status: 'publicado',
    initialBid: 100, lastBid: 0, bidCount: 0, title: 'Lote de teste',
    endTime: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
  });

  const ctx = (uid) => ({ auth: { uid } });

  await t('CRÍTICO: placeBid BLOQUEIA bidder da org B tentando dar lance em lote da org A', async () => {
    await assertRejectsWithCode(
      () => fns.placeBid.run({ lotId: lotRef.id, amount: 110 }, ctx('auc_bidder_b')),
      'permission-denied'
    );
  });

  await t('placeBid PERMITE bidder da própria organização (fluxo normal continua funcionando)', async () => {
    const result = await fns.placeBid.run({ lotId: lotRef.id, amount: 110 }, ctx('auc_bidder_a'));
    assert.ok(result.bidId);
    const lotSnap = await lotRef.get();
    assert.strictEqual(lotSnap.data().lastBid, 110);
    assert.strictEqual(lotSnap.data().lastBidderUid, 'auc_bidder_a');
  });

  await t('sanidade: lote da org A permanece com orgId correto após o lance', async () => {
    const snap = await lotRef.get();
    assert.strictEqual(snap.data().orgId, 'auc_org_a');
  });

  // ---- gerarCobrancaLeilao / liberarRepasse: venda sintética já com orgId ----
  const saleRef = await db.collection('auctionSales').add({
    orgId: 'auc_org_a', lotId: lotRef.id, lotTitle: 'Lote de teste',
    sellerUid: 'auc_seller_a', buyerUid: 'auc_bidder_a',
    finalAmount: 110, netSeller: 99, status: 'aguardando_pagamento',
  });

  await t('gerarCobrancaLeilao: admin da org B NÃO consegue gerar cobrança para venda da org A', async () => {
    await assertRejectsWithCode(
      () => fns.gerarCobrancaLeilao.run({ saleId: saleRef.id }, ctx('auc_admin_b')),
      'permission-denied'
    );
  });

  await t('gerarCobrancaLeilao: usuário sem nenhuma relação com a venda é bloqueado', async () => {
    await assertRejectsWithCode(
      () => fns.gerarCobrancaLeilao.run({ saleId: saleRef.id }, ctx('auc_bidder_b')),
      'permission-denied'
    );
  });

  await db.collection('auctionSales').doc(saleRef.id).update({ status: 'pago' });

  await t('liberarRepasse: admin da org B NÃO consegue liberar repasse de venda da org A', async () => {
    await assertRejectsWithCode(
      () => fns.liberarRepasse.run({ saleId: saleRef.id }, ctx('auc_admin_b')),
      'permission-denied'
    );
  });

  await t('sanidade: venda da org A não foi alterada pelas tentativas cross-tenant', async () => {
    const snap = await saleRef.get();
    assert.strictEqual(snap.data().status, 'pago'); // não virou 'repasse_liberado'
    assert.strictEqual(snap.data().orgId, 'auc_org_a');
  });

  // ---- backfillLeilaoOrgId ----
  await t('backfillLeilaoOrgId: apenas master pode chamar', async () => {
    await assertRejectsWithCode(
      () => fns.backfillLeilaoOrgId.run({}, ctx('auc_admin_a')),
      'permission-denied'
    );
  });

  await t('backfillLeilaoOrgId: preenche orgId em doc sem o campo, sem sobrescrever quem já tem', async () => {
    const semOrgRef = await db.collection('auctionNotifications').add({
      recipientUid: 'auc_seller_a', type: 'teste_legado', message: 'doc anterior à Fase 2C, sem orgId',
    });
    const comOrgRef = await db.collection('auctionNotifications').add({
      orgId: 'auc_org_b', recipientUid: 'auc_bidder_b', type: 'teste_ja_migrado', message: 'já tinha orgId',
    });

    const result = await fns.backfillLeilaoOrgId.run({ orgId: 'auc_org_a' }, ctx('auc_master_a'));
    assert.ok(result.results.auctionNotifications.atualizados >= 1);

    const semOrgSnap = await semOrgRef.get();
    assert.strictEqual(semOrgSnap.data().orgId, 'auc_org_a', 'doc sem orgId deveria ter sido preenchido');

    const comOrgSnap = await comOrgRef.get();
    assert.strictEqual(comOrgSnap.data().orgId, 'auc_org_b', 'doc que já tinha orgId NUNCA deveria ser sobrescrito');
  });
};
