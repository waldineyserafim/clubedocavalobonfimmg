// functions-prospecting/scripts/outbound-weekly-list.js — lista os leads
// elegíveis pro Outbound semanal manual via Claude Code (ver CLAUDE.md "Pivô
// Gemini/Claude Code" e .claude/commands/outbound-weekly.md). Rodado
// LOCALMENTE (nunca em Cloud Function), autenticado por Application Default
// Credentials da sua própria conta Google (`gcloud auth application-default
// login`) — nunca uma service account key em disco (ver CLAUDE.md, "Acesso
// do Claude Code ao Firestore").
//
// Só LEITURA. Não escreve nada — a escrita é outbound-weekly-write.js.
//
// Critério de elegibilidade (CLAUDE.md, "Seleção dos leads"):
//   - lead não arquivado;
//   - nenhuma abordagem ainda (outboundMessages/{leadId} não existe), OU a
//     abordagem existente está em "failed"/"rejected" (reabordável);
//   - ordenado por aiProspecting.score desc (leads sem score de IA — cadastro
//     manual — vêm depois, sem ordenação por score).
//
// Uso: node scripts/outbound-weekly-list.js [--limit=20]
// Saída: JSON em stdout — { totalQualificados, jaAbordados, elegiveis: [...], selecionados: [...] }

// Usa @google-cloud/firestore DIRETO (não firebase-admin) — o SDK do
// firebase-admin não suporta credenciais de Workload Identity Federation
// exportadas pelo google-github-actions/auth ("This option is not supported
// by Firebase Admin SDK", doc oficial da action). @google-cloud/firestore
// fala com o google-auth-library por baixo, que suporta WIF nativamente —
// funciona igual com ADC local (gcloud auth application-default login) e
// com WIF dentro do runner do GitHub Actions, sem trocar nada.
const { Firestore } = require('@google-cloud/firestore');
const { getEligibleLeads } = require('../lib/outbound/eligibility');

function parseArgs(argv) {
  const out = { limit: 20 };
  for (const arg of argv) {
    const m = arg.match(/^--limit=(\d+)$/);
    if (m) out.limit = Math.max(1, Math.min(100, parseInt(m[1], 10)));
  }
  return out;
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));

  const db = new Firestore({ projectId: 'clubecavalobonfim' });

  const { totalQualificados, jaAbordados, elegiveis, selecionados: selecionadosBrutos } = await getEligibleLeads({ db, limit });

  const resumo = selecionadosBrutos.map((lead) => ({
    id: lead.id,
    organizacaoNome: lead.organizacaoNome,
    segmento: lead.segmento,
    cidade: lead.cidade,
    estado: lead.estado,
    contatoNome: lead.contatoNome,
    contatoCargo: lead.contatoCargo,
    contatoWhatsapp: lead.contatoWhatsapp,
    contatoEmail: lead.contatoEmail,
    dores: lead.dores,
    necessidades: lead.necessidades,
    observacoes: lead.observacoes,
    aiProspecting: lead.aiProspecting
      ? {
        score: lead.aiProspecting.score,
        qualificacao: lead.aiProspecting.qualificacao,
        evidence: lead.aiProspecting.evidence || [],
      }
      : null,
  }));

  console.log(JSON.stringify({
    totalQualificados,
    jaAbordados,
    elegiveis,
    limite: limit,
    selecionados: resumo,
  }, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error('outbound-weekly-list: erro:', e.message);
  process.exit(1);
});
