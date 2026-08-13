// functions/lib/outbound/eligibility.js — critério ÚNICO de "lead elegível
// pro Outbound", reaproveitado por scripts/outbound-weekly-list.js (Claude
// Code local) E pelas Cloud Functions previewOutboundRemoteRun/
// requestOutboundRemoteRun (botão "Executar Outbound IA" no Portal) — nunca
// duas implementações do mesmo critério (ver CLAUDE.md "Botão Executar
// Outbound IA").
//
// Critério (igual ao que já valia no fluxo manual, ver CLAUDE.md "Seleção
// dos leads"):
//   - lead não arquivado;
//   - nenhuma abordagem ainda, OU abordagem existente em "failed"/"rejected"
//     (reabordável);
//   - ordenado por aiProspecting.score desc (leads sem score — cadastro
//     manual — vêm depois, sem ordenação por score).

// Mesmo enum de lib/outbound/messages.js.
const SKIP_IF_STATUS = ['pending', 'generating', 'ready_for_review', 'approved', 'edited', 'sent', 'responded'];

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {number} [opts.limit=20]
 */
async function getEligibleLeads({ db, limit = 20 } = {}) {
  const leadsSnap = await db.collection('leads').where('archived', '==', false).get();
  const outboundSnap = await db.collection('outboundMessages').get();
  const outboundByLeadId = new Map(outboundSnap.docs.map((d) => [d.id, d.data()]));

  const qualificados = [];
  let jaAbordados = 0;

  for (const doc of leadsSnap.docs) {
    const lead = { id: doc.id, ...doc.data() };
    const existing = outboundByLeadId.get(doc.id);
    if (existing && SKIP_IF_STATUS.includes(existing.status)) {
      jaAbordados += 1;
      continue;
    }
    qualificados.push(lead);
  }

  qualificados.sort((a, b) => {
    const scoreA = a.aiProspecting?.score;
    const scoreB = b.aiProspecting?.score;
    if (Number.isFinite(scoreA) && Number.isFinite(scoreB)) return scoreB - scoreA;
    if (Number.isFinite(scoreA)) return -1;
    if (Number.isFinite(scoreB)) return 1;
    return 0;
  });

  const selecionados = qualificados.slice(0, limit);

  return {
    totalQualificados: qualificados.length,
    jaAbordados,
    elegiveis: qualificados.length,
    limite: limit,
    selecionados,
  };
}

module.exports = { getEligibleLeads, SKIP_IF_STATUS };
