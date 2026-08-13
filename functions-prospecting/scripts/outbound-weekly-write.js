// functions-prospecting/scripts/outbound-weekly-write.js — grava UMA
// abordagem gerada pelo Claude Code local (Claude Pro, não a API paga da
// Anthropic) em outboundMessages/{leadId}, reaproveitando o MESMO
// lib/outbound/messages.js que a Cloud Function generateOutboundMessage já
// usa (claimForGeneration + recordVersion) — nunca uma segunda forma de
// escrever esse contrato (ver CLAUDE.md "Pivô Gemini/Claude Code").
//
// Rodado LOCALMENTE, mesma autenticação (ADC) de outbound-weekly-list.js.
//
// Uso: node scripts/outbound-weekly-write.js --leadId=abc123 --file=/tmp/abordagem.json
// onde o arquivo JSON tem: { channel, subject, message, cta, personalizationSummary, motivos[], evidence[] }
// (evidence deve vir das evidências já coletadas pela Prospecção — ver
// CLAUDE.md "Pesquisa adicional no Outbound": nenhuma pesquisa nova nesta
// primeira versão do fluxo manual).

const fs = require('fs');
const admin = require('firebase-admin');
const { createOutboundMessagesService } = require('../lib/outbound/messages');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const { leadId, file } = parseArgs(process.argv.slice(2));
  if (!leadId) throw new Error('--leadId é obrigatório.');
  if (!file) throw new Error('--file é obrigatório (JSON com subject/message/cta/personalizationSummary/motivos/evidence).');

  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!content.message || !content.personalizationSummary) {
    throw new Error('O JSON precisa ter, no mínimo, "message" e "personalizationSummary".');
  }

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'clubecavalobonfim' });
  }
  const db = admin.firestore();
  const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
  const messagesService = createOutboundMessagesService({ db, serverTimestamp });

  const generatedBy = process.env.OUTBOUND_WEEKLY_OPERATOR || 'claude_code_local';
  const channel = content.channel || 'email';

  const claim = await messagesService.claimForGeneration(leadId, { channel, createdBy: generatedBy });

  const { versionId, status } = await messagesService.recordVersion(leadId, {
    source: 'ai_generated',
    trigger: claim.isRegeneration ? 'regenerate' : 'initial',
    subject: content.subject || '',
    message: content.message,
    cta: content.cta || '',
    personalizationSummary: content.personalizationSummary,
    motivos: content.motivos || [],
    evidence: content.evidence || [],
    researchPerformed: false, // fluxo manual não pesquisa web adicional nesta versão (CLAUDE.md "Pesquisa adicional")
    usage: null, // sem chamada de API paga — geração via Claude Pro (assinatura), não Messages API
    costUsd: 0,
    searchesPerformed: 0,
    createdBy: generatedBy,
  });

  console.log(JSON.stringify({ leadId, versionId, status }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('outbound-weekly-write: erro:', e.message);
  process.exit(1);
});
