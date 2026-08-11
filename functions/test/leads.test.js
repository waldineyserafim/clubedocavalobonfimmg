// Testa o módulo de Leads (Release 2) — lib/leads.js direto (validação pura
// de campos) e as 4 Cloud Functions exportadas (autorização + ciclo completo
// contra o emulador real). Mesmo padrão de platform.test.js/features.test.js.
const assert = require('assert');
const { seedPlatformAdmin } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'leads_admin_1', email: 'leads.admin@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'leads_operator_1', email: 'leads.operator@teste.local', role: 'operator' });

  /* =======================================================================
     Autorização — só administrator/owner (operator excluído por completo,
     ao contrário de platformAdmins/featureFlags onde operator tem leitura).
     ======================================================================= */

  await t('createLead: operator é rejeitado com permission-denied', async () => {
    await assertRejectsWithCode(
      () => fns.createLead.run({ organizacaoNome: 'Clube Teste' }, ctx('leads_operator_1')),
      'permission-denied'
    );
  });

  await t('createLead: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(
      () => fns.createLead.run({ organizacaoNome: 'Clube Teste' }, ctx(null)),
      'unauthenticated'
    );
  });

  /* =======================================================================
     createLead — validação e defaults
     ======================================================================= */

  await t('createLead: organizacaoNome vazio rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.createLead.run({ organizacaoNome: '  ' }, ctx('leads_admin_1')),
      'invalid-argument'
    );
  });

  await t('createLead: enum inválido (segmento) rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.createLead.run({ organizacaoNome: 'Clube X', segmento: 'clube_de_futebol' }, ctx('leads_admin_1')),
      'invalid-argument'
    );
  });

  let leadId;
  await t('createLead: cria com defaults seguros (status novo, responsavelUid = criador, nunca vazio)', async () => {
    const result = await fns.createLead.run({
      organizacaoNome: 'Clube dos Testadores',
      segmento: 'clube',
      cidade: 'Belo Horizonte',
      estado: 'MG',
      contatoNome: 'Fulano',
      origem: 'indicacao',
      proximaAcao: { tipo: 'ligacao', data: '2026-08-20T10:00:00.000Z', descricao: 'Primeira ligação', concluida: false },
    }, ctx('leads_admin_1'));
    leadId = result.id;
    const snap = await db.collection('leads').doc(leadId).get();
    const lead = snap.data();
    assert.strictEqual(lead.status, 'novo');
    assert.strictEqual(lead.ownerUid, 'leads_admin_1');
    assert.strictEqual(lead.responsavelUid, 'leads_admin_1');
    assert.strictEqual(lead.prioridade, 'media');
    assert.strictEqual(lead.sistemaAtual, 'nenhum');
    assert.strictEqual(lead.archived, false);
    assert.strictEqual(lead.ultimaInteracao, null);
    assert.strictEqual(lead.proximaAcao.tipo, 'ligacao');
    assert.ok(lead.proximaAcao.data);
  });

  await t('createLead: responsavelUid enviado pelo cliente é ignorado — criador sempre vira responsável inicial', async () => {
    const result = await fns.createLead.run({
      organizacaoNome: 'Outro Clube',
      responsavelUid: 'alguem_que_nao_e_o_criador',
    }, ctx('leads_admin_1'));
    const snap = await db.collection('leads').doc(result.id).get();
    assert.strictEqual(snap.data().responsavelUid, 'leads_admin_1');
    await db.collection('leads').doc(result.id).delete();
  });

  /* =======================================================================
     updateLead
     ======================================================================= */

  await t('updateLead: lead inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(
      () => fns.updateLead.run({ id: 'lead_que_nao_existe', status: 'qualificado' }, ctx('leads_admin_1')),
      'not-found'
    );
  });

  await t('updateLead: responsavelUid vazio rejeita invalid-argument (nunca fica sem responsável)', async () => {
    await assertRejectsWithCode(
      () => fns.updateLead.run({ id: leadId, responsavelUid: '   ' }, ctx('leads_admin_1')),
      'invalid-argument'
    );
  });

  await t('updateLead: avança status no pipeline e reatribui responsável', async () => {
    await fns.updateLead.run({ id: leadId, status: 'qualificado', responsavelUid: 'leads_owner_qualquer' }, ctx('leads_admin_1'));
    const snap = await db.collection('leads').doc(leadId).get();
    assert.strictEqual(snap.data().status, 'qualificado');
    assert.strictEqual(snap.data().responsavelUid, 'leads_owner_qualquer');
  });

  await t('updateLead: status fora do enum rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.updateLead.run({ id: leadId, status: 'ganho' }, ctx('leads_admin_1')),
      'invalid-argument'
    );
  });

  /* =======================================================================
     addLeadHistory — atualiza ultimaInteracao na mesma operação
     ======================================================================= */

  await t('addLeadHistory: tipo fora do enum rejeita invalid-argument', async () => {
    await assertRejectsWithCode(
      () => fns.addLeadHistory.run({ leadId, tipo: 'carta_registrada', data: '2026-08-21T10:00:00.000Z' }, ctx('leads_admin_1')),
      'invalid-argument'
    );
  });

  await t('addLeadHistory: registra interação e atualiza ultimaInteracao do lead', async () => {
    const before = await db.collection('leads').doc(leadId).get();
    assert.strictEqual(before.data().ultimaInteracao, null);

    const result = await fns.addLeadHistory.run({
      leadId, tipo: 'whatsapp', data: '2026-08-21T10:00:00.000Z', descricao: 'Confirmou interesse',
    }, ctx('leads_admin_1'));

    const historySnap = await db.collection('leads').doc(leadId).collection('history').doc(result.id).get();
    assert.strictEqual(historySnap.data().tipo, 'whatsapp');

    const after = await db.collection('leads').doc(leadId).get();
    assert.ok(after.data().ultimaInteracao, 'ultimaInteracao deveria ter sido preenchido');
  });

  await t('addLeadHistory: leadId inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(
      () => fns.addLeadHistory.run({ leadId: 'lead_fantasma', tipo: 'email', data: '2026-08-21T10:00:00.000Z' }, ctx('leads_admin_1')),
      'not-found'
    );
  });

  /* =======================================================================
     archiveLead — soft delete
     ======================================================================= */

  await t('archiveLead: lead inexistente rejeita not-found', async () => {
    await assertRejectsWithCode(
      () => fns.archiveLead.run({ id: 'lead_que_nao_existe' }, ctx('leads_admin_1')),
      'not-found'
    );
  });

  await t('archiveLead: arquiva e desarquiva (soft delete, nunca hard delete)', async () => {
    await fns.archiveLead.run({ id: leadId, archived: true }, ctx('leads_admin_1'));
    let snap = await db.collection('leads').doc(leadId).get();
    assert.strictEqual(snap.data().archived, true);
    assert.ok(snap.exists, 'documento nunca deve ser apagado — só arquivado');

    await fns.archiveLead.run({ id: leadId, archived: false }, ctx('leads_admin_1'));
    snap = await db.collection('leads').doc(leadId).get();
    assert.strictEqual(snap.data().archived, false);
  });

  // Limpeza
  await db.collection('leads').doc(leadId).delete();
};
