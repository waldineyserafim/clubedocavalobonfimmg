// functions/test/outbound-eligibility.test.js — lib/outbound/eligibility.js,
// critério ÚNICO de elegibilidade reaproveitado por scripts/outbound-weekly-
// list.js e pelas Cloud Functions previewOutboundRemoteRun/
// requestOutboundRemoteRun (botão "Executar Outbound IA").
const assert = require('assert');
const { seedLead } = require('./helpers/seed');
const { getEligibleLeads } = require('../lib/outbound/eligibility');

module.exports = async function run({ db, t }) {
  await t('getEligibleLeads: exclui arquivados e já abordados, ordena por score desc', async () => {
    await seedLead(db, { id: 'elig_alto', organizacaoNome: 'Alto', aiProspecting: { score: 90, qualificacao: 'quente', evidence: [] } });
    await seedLead(db, { id: 'elig_baixo', organizacaoNome: 'Baixo', aiProspecting: { score: 40, qualificacao: 'quente', evidence: [] } });
    await seedLead(db, { id: 'elig_manual', organizacaoNome: 'Manual' });
    await seedLead(db, { id: 'elig_arquivado', organizacaoNome: 'Arquivado', archived: true });
    await seedLead(db, { id: 'elig_enviado', organizacaoNome: 'Enviado' });
    await db.collection('outboundMessages').doc('elig_enviado').set({ status: 'sent' });

    const result = await getEligibleLeads({ db, limit: 10 });
    const ids = result.selecionados.map((l) => l.id);

    assert.ok(ids.includes('elig_alto'));
    assert.ok(ids.includes('elig_baixo'));
    assert.ok(ids.includes('elig_manual'));
    assert.ok(!ids.includes('elig_arquivado'));
    assert.ok(!ids.includes('elig_enviado'));
    assert.ok(ids.indexOf('elig_alto') < ids.indexOf('elig_baixo'));
    assert.strictEqual(result.jaAbordados, 1);

    await Promise.all(['elig_alto', 'elig_baixo', 'elig_manual', 'elig_arquivado', 'elig_enviado'].map((id) => db.collection('leads').doc(id).delete()));
    await db.collection('outboundMessages').doc('elig_enviado').delete();
  });

  await t('getEligibleLeads: respeita o limit passado', async () => {
    for (let i = 0; i < 5; i++) await seedLead(db, { id: `elig_limit_${i}`, organizacaoNome: `Limit ${i}` });
    const result = await getEligibleLeads({ db, limit: 2 });
    assert.strictEqual(result.selecionados.length, 2);
    assert.ok(result.totalQualificados >= 5);
    for (let i = 0; i < 5; i++) await db.collection('leads').doc(`elig_limit_${i}`).delete();
  });
};
