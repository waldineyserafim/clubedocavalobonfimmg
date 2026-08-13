// functions/test/prospecting-callables.test.js — Cloud Function
// requestProspectingRun (botão "Gerar Leads IA" + "Executar agora" em
// admin/prospeccao-ia.html), através de `fns.requestProspectingRun.run()`.
//
// IMPORTANTE: uma chamada autorizada de verdade chegaria em
// enqueueProspectingRun() → getFunctions().taskQueue(...).enqueue(), que
// precisa de infraestrutura real do Cloud Tasks — não disponível nos
// emuladores locais (só firestore/auth/storage, ver run-all.js). Por isso
// este arquivo testa SÓ a rejeição de autorização (a checagem de papel
// acontece ANTES de qualquer tentativa de enqueue, então é seguro exercitar
// via a Cloud Function real). O comportamento de concorrência/lock/trigger
// já é coberto em prospecting-engine.test.js, direto contra
// lib/prospecting/engine.js (mesmo motor que esta callable usa).
const { seedPlatformAdmin } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await seedPlatformAdmin(db, authInstance, { uid: 'prc_operator_1', email: 'prc.operator@teste.local', role: 'operator' });

  await t('requestProspectingRun: operator é rejeitado com permission-denied (nunca chega a enfileirar a task)', async () => {
    await assertRejectsWithCode(
      () => fns.requestProspectingRun.run({ campaignId: 'qualquer' }, ctx('prc_operator_1')),
      'permission-denied'
    );
  });

  await t('requestProspectingRun: não-autenticado é rejeitado com unauthenticated', async () => {
    await assertRejectsWithCode(
      () => fns.requestProspectingRun.run({ campaignId: 'qualquer' }, ctx(null)),
      'unauthenticated'
    );
  });
};
