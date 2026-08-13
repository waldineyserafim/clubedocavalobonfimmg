// functions-prospecting/index.js — codebase Firebase Functions separado
// (`prospecting`), isolado do codebase `default` (functions/index.js, Portal
// Associativo/CCBMG) especificamente para que o deploy de um nunca dependa
// da validação do outro — o Firebase CLI valida TODO o codebase antes de
// aplicar qualquer filtro `--only functions:nome`, então um problema de
// deploy neste codebase nunca bloqueia o deploy de functions do Portal que
// não têm nada a ver com isso (e vice-versa).
//
// executeProspectingRun/executeOutboundBatch precisam de timeoutSeconds:1800
// (30min) — acima do teto de 540s (9min) que vale IGUALMENTE pra Gen1 e Gen2
// quando o gatilho é baseado em evento via Eventarc (Firestore/Pub-Sub/
// Storage; tentativa anterior usava onDocumentCreated e falhou no deploy
// real por isso — "Gen2 permite timeout maior" só vale pra HTTPS/callable,
// não pra gatilho de evento). A solução é gatilho de TASK QUEUE
// (`onTaskDispatched`, backed by Cloud Tasks, não Eventarc) — esse tipo
// suporta até 1800s oficialmente. Por isso requestProspectingRun/
// requestOutboundBatch, depois de criar o doc "queued" (pro cliente
// acompanhar via onSnapshot, como antes), agora também enfileiram
// explicitamente uma task — via lib/cloudTasksDispatch.js (REST direto ao
// Cloud Tasks), NÃO `getFunctions().taskQueue(...).enqueue(...)`: achado
// real (confirmado por depuração, não hipótese) é que esse wrapper do
// firebase-admin falha consistentemente neste ambiente com "Queue does not
// exist" mesmo com IAM correto e a mesma chamada funcionando via REST puro —
// o botão "Gerar Leads IA"/scheduler nunca tinham sido exercidos de ponta a
// ponta antes disso ser descoberto. Os motores de execução
// (executeProspectingRun/executeOutboundBatch) leem `request.data` em vez de
// `event.params`, mas continuam chamando engine.executeRun/executeBatch
// exatamente como antes.
//
// Este arquivo é uma extração 1:1 do que já existia em functions/index.js —
// nenhuma lógica de negócio foi alterada (ver lib/prospecting/*, lib/outbound/*,
// movidos verbatim desta separação). lib/leads.js e lib/platform.js são
// cópias do mesmo arquivo em functions/lib/ (ambos os codebases precisam,
// cada codebase é empacotado/deployado de forma independente e autocontida —
// duplicação pequena e deliberada, não uma arquitetura nova).
//
// Deploy: firebase deploy --only functions:prospecting
// (o codebase `default`, em functions/, continua: firebase deploy --only functions:default)

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { GoogleAuth } = require('google-auth-library');
const { createCloudTasksDispatcher } = require('./lib/cloudTasksDispatch');

const { createPlatformResolver, createPlatformAuthorizationHelpers } = require('./lib/platform');
const { createLeadsService } = require('./lib/leads');
const { createCampaignsService } = require('./lib/prospecting/campaigns');
const { createClaudeProvider } = require('./lib/prospecting/claudeProvider');
const { createGeminiProvider } = require('./lib/prospecting/geminiProvider');
const { createDedupService } = require('./lib/prospecting/dedup');
const { createProspectingEngine } = require('./lib/prospecting/engine');
const { createSalesContextService } = require('./lib/outbound/salesContext');
const { createOutboundMessagesService } = require('./lib/outbound/messages');
const { createOutboundEngine } = require('./lib/outbound/engine');
const { getEligibleLeads } = require('./lib/outbound/eligibility');
const { createRemoteRunsService } = require('./lib/outbound/remoteRuns');
const { createGithubDispatchService } = require('./lib/outbound/githubDispatch');

// Prospecção IA — Gemini 2.5 Flash + Google Search Grounding (chave da
// Gemini Developer API / aistudio.google.com — free tier real, sem Vertex
// AI; ver CLAUDE.md "Pivô Gemini"). Agente de Outbound continua na Anthropic
// (ver claudeProvider abaixo) — preservado, não usado pelo fluxo semanal
// manual (ver scripts/outbound-weekly*.js), mas nunca apagado.
const GEMINI_SECRET = 'projects/clubecavalobonfim/secrets/gemini-api-key/versions/latest';
const ANTHROPIC_SECRET = 'projects/clubecavalobonfim/secrets/anthropic-api-key/versions/latest';
// Botão "Executar Outbound IA" — token com escopo `repo`+`workflow` usado só
// pra chamar POST .../actions/workflows/outbound-weekly.yml/dispatches (ver
// lib/outbound/githubDispatch.js). Nunca a Anthropic API — quem gera as
// abordagens é o Claude Code dentro do runner do GitHub Actions, autenticado
// por CLAUDE_CODE_OAUTH_TOKEN (GitHub Secret, não Secret Manager — vive no
// próprio GitHub Actions, nunca chega a este backend).
const GITHUB_DISPATCH_SECRET = 'projects/clubecavalobonfim/secrets/github-actions-dispatch-token/versions/latest';

admin.initializeApp();
const db = admin.firestore();
const secretClient = new SecretManagerServiceClient();

async function getSecret(name) {
  const [version] = await secretClient.accessSecretVersion({ name });
  return version.payload.data.toString();
}

// Cloud Tasks via REST direto (ver lib/cloudTasksDispatch.js pro achado real
// de por que não usamos getFunctions().taskQueue()). Mesma identidade
// (Application Default Credentials do runtime da function) que já é usada
// implicitamente pelo admin.initializeApp() acima.
const cloudTasksAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const cloudTasksDispatcher = createCloudTasksDispatcher({
  getAccessToken: async () => {
    const client = await cloudTasksAuth.getClient();
    const { token } = await client.getAccessToken();
    return token;
  },
});

// Plano de identidade de PLATAFORMA (Fase 3.2) — idêntico ao bootstrap de
// functions/index.js (mesmo lib/platform.js, cópia — ver comentário no topo).
const platformResolver = createPlatformResolver({ db });
const platformAuth = createPlatformAuthorizationHelpers({ platformResolver });

// Idêntico a functions/index.js — mesma coleção systemLogs, mesmo shape.
async function writePlatformAuditLog(action, details, context) {
  try {
    await db.collection('systemLogs').add({
      userId: context.auth?.uid || null,
      userEmail: context.auth?.token?.email || null,
      orgId: 'platform',
      action,
      details: details || {},
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writePlatformAuditLog: falha ao gravar auditoria (ignorado):', e.message);
  }
}

// Release 2 — Leads: aqui só para prospectingEngine criar leads a partir de
// candidatos qualificados pela IA (nunca um CRUD próprio — createLead/
// updateLead/archiveLead/addLeadHistory continuam só no codebase `default`).
const leadsService = createLeadsService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});

const campaignsService = createCampaignsService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});
const dedupService = createDedupService({ db });
const claudeProvider = createClaudeProvider({ getApiKey: () => getSecret(ANTHROPIC_SECRET) });
const geminiProvider = createGeminiProvider({ getApiKey: () => getSecret(GEMINI_SECRET) });

/** Avisa Platform Administrator/Owner ao final de cada execução (mesmo transporter/credenciais do relatório diário) — nunca deixa a execução falhar por causa de e-mail (ver engine.js, chamado dentro de .catch()). */
async function notifyProspectingRunFinished({ campaign, runId, status, metrics, error }) {
  const adminsSnap = await db.collection('platformAdmins').where('role', 'in', ['administrator', 'owner']).get();
  const recipients = adminsSnap.docs.map((d) => d.data()).filter((a) => a.ativo !== false && a.email).map((a) => a.email);
  if (!recipients.length) return;

  const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');
  const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPassword } });

  const statusLabel = { completed: 'Concluída', interrompida: 'Interrompida por limite de consumo', failed: 'Erro' }[status] || status;
  const html = `
    <h2>Prospecção IA — ${campaign.name}</h2>
    <p>Status: <strong>${statusLabel}</strong></p>
    <ul>
      <li>Leads criados: ${metrics.leadsCriados}</li>
      <li>Candidatos analisados: ${metrics.candidatosAnalisados}</li>
      <li>Candidatos rejeitados: ${metrics.candidatosRejeitados}</li>
      <li>Leads duplicados (ignorados): ${metrics.leadsDuplicados}</li>
      <li>Pesquisas realizadas: ${metrics.searchesPerformed}</li>
      <li>Score médio: ${metrics.scoreMedio ?? '-'}</li>
      <li>Custo estimado: US$ ${Number(metrics.custoEstimadoUsd || 0).toFixed(4)}</li>
    </ul>
    ${error ? `<p style="color:#b00"><strong>Erro:</strong> ${error}</p>` : ''}
  `;
  await transporter.sendMail({
    from: emailUser,
    to: recipients.join(','),
    subject: `Prospecção IA — ${campaign.name}: ${metrics.leadsCriados} lead(s) — ${statusLabel}`,
    html,
  });
}

const prospectingEngine = createProspectingEngine({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  aiProvider: geminiProvider,
  leadsService,
  dedupService,
  notify: notifyProspectingRunFinished,
});

// Agente de Outbound — transforma leads qualificados (achados pela
// Prospecção IA acima, ou cadastrados manualmente) em abordagens comerciais
// revisadas por humano antes de qualquer contato externo (ver CLAUDE.md
// "Agente de Outbound"). Reaproveita a MESMA instância de `claudeProvider`
// construída acima — nunca uma segunda integração Claude — e o Lead
// existente — nunca um segundo cadastro de prospect.
const salesContextService = createSalesContextService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});
const outboundMessagesService = createOutboundMessagesService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});
const outboundEngine = createOutboundEngine({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  messagesService: outboundMessagesService,
  salesContextService,
  aiProvider: claudeProvider,
});

// Botão "Executar Outbound IA" (admin/leads.html) — dispara o Claude Code
// remotamente via GitHub Actions (Claude Pro, nunca Anthropic API). Ver
// CLAUDE.md "Botão Executar Outbound IA" e .github/workflows/outbound-weekly.yml.
const remoteRunsService = createRemoteRunsService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});
const githubDispatchService = createGithubDispatchService({
  getToken: () => getSecret(GITHUB_DISPATCH_SECRET),
});

/* =========================================================================
   PROSPECÇÃO IA — agente autônomo de prospecção comercial via Claude, que
   alimenta o mesmo `leads` acima (nunca um CRM por organização — decisão de
   escopo registrada em CLAUDE.md, "Prospecção IA"). CRUD de campanhas
   restrito a Platform Administrator/Owner, mesma garantia estrutural de
   featureFlags/leads (Firestore Rules: write:false, só Cloud Function
   escreve). O ciclo de execução em si mora em lib/prospecting/engine.js —
   ver ali o porquê de ser dividido em requestRun (rápido, Gen1) e
   executeRun (longo, Gen2, abaixo).
   ========================================================================= */

exports.createProspectingCampaign = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const { id } = await campaignsService.createCampaign(data || {}, { createdBy: caller.uid });
  await writePlatformAuditLog('prospeccao_campanha_criada', { id, name: data?.name }, context);
  console.log(`createProspectingCampaign: id=${id} por caller=${caller.uid}`);
  return { id };
});

exports.updateProspectingCampaign = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const id = String(data?.id || '').trim();
  if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
  const fields = { ...(data || {}) };
  delete fields.id;
  await campaignsService.updateCampaign(id, fields);
  await writePlatformAuditLog('prospeccao_campanha_atualizada', { id, campos: Object.keys(fields) }, context);
  console.log(`updateProspectingCampaign: id=${id} por caller=${caller.uid}`);
  return { success: true };
});

exports.setProspectingCampaignStatus = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const id = String(data?.id || '').trim();
  if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
  await campaignsService.setStatus(id, data?.status);
  await writePlatformAuditLog('prospeccao_campanha_status_alterado', { id, status: data?.status }, context);
  console.log(`setProspectingCampaignStatus: id=${id} status=${data?.status} por caller=${caller.uid}`);
  return { success: true };
});

exports.archiveProspectingCampaign = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const id = String(data?.id || '').trim();
  if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
  await campaignsService.archiveCampaign(id);
  await writePlatformAuditLog('prospeccao_campanha_arquivada', { id }, context);
  console.log(`archiveProspectingCampaign: id=${id} por caller=${caller.uid}`);
  return { success: true };
});

// Enfileira a task que dispara executeProspectingRun (ver comentário no topo
// do arquivo — task queue function, não gatilho de evento). Usa
// lib/cloudTasksDispatch.js (REST direto), não getFunctions().taskQueue() —
// ver comentário no topo do próprio arquivo pro achado real de por quê.
async function enqueueProspectingRun(runId) {
  await cloudTasksDispatcher.enqueueCloudTask({ queueName: 'executeProspectingRun', payload: { runId } });
}

// "Executar agora" — deliberadamente RÁPIDO (ver lib/prospecting/engine.js):
// só reivindica o lock da campanha e cria o doc de execução com status
// "queued"; devolve o runId na hora. Quem roda o ciclo de verdade é
// executeProspectingRun (task queue function, abaixo), disparado pela task
// enfileirada logo em seguida. O cliente acompanha o progresso ao vivo via
// onSnapshot em prospectingRuns/{runId} — mesma UX do assistente de
// provisionamento.
exports.requestProspectingRun = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const campaignId = String(data?.campaignId || '').trim();
  if (!campaignId) throw new functions.https.HttpsError('invalid-argument', 'campaignId é obrigatório.');
  const result = await prospectingEngine.requestRun({
    campaignId, trigger: 'manual', requestedBy: caller.uid, requestedByEmail: context.auth?.token?.email || null,
  });
  if (result.skipped) {
    throw new functions.https.HttpsError('failed-precondition', result.reason);
  }
  await enqueueProspectingRun(result.runId);
  await writePlatformAuditLog('prospeccao_execucao_solicitada', { campaignId, runId: result.runId }, context);
  console.log(`requestProspectingRun: campaignId=${campaignId} runId=${result.runId} por caller=${caller.uid}`);
  return result;
});

// Execução agendada semanal (CLAUDE.md, "Configuração padrão da primeira
// versão") — segunda-feira de manhã, mesmo fuso das demais rotinas agendadas
// deste arquivo. Só solicita (requestRun) e enfileira — quem executa de
// verdade é executeProspectingRun, abaixo.
exports.prospectingScheduledRun = functions.pubsub.schedule('0 8 * * 1')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const snap = await db.collection('prospectingCampaigns')
      .where('status', '==', 'active')
      .where('execution.frequencia', '==', 'weekly')
      .get();
    console.log(`prospectingScheduledRun: ${snap.size} campanha(s) ativa(s) com frequência semanal.`);
    for (const doc of snap.docs) {
      try {
        const result = await prospectingEngine.requestRun({ campaignId: doc.id, trigger: 'scheduled' });
        if (!result.skipped) {
          await enqueueProspectingRun(result.runId);
        }
        console.log(`prospectingScheduledRun: campaignId=${doc.id} ->`, result);
      } catch (e) {
        console.error(`prospectingScheduledRun: falha ao solicitar execução da campanha ${doc.id}: ${e.message}`);
      }
    }
  });

// Motor de execução de verdade (pesquisa + qualificação + criação de leads).
// Task queue function por precisar de um timeout muito maior que o teto de
// 540s (9min) que vale pra gatilhos de evento (Firestore/Pub-Sub/Storage),
// tanto Gen1 quanto Gen2 — único desvio deliberado do padrão HTTPS/callable
// do resto deste arquivo, justificado por ser a única carga de trabalho
// longa do backend (ver CLAUDE.md, "Prospecção IA — risco de timeout").
// Disparado pela TASK enfileirada por requestProspectingRun/
// prospectingScheduledRun logo após criar o doc "queued" — nunca reprocessa
// a mesma execução em loop (sem retry automático: maxAttempts:1, já que
// engine.executeRun grava progresso incremental e uma retentativa do zero
// duplicaria trabalho).
exports.executeProspectingRun = onTaskDispatched(
  { retryConfig: { maxAttempts: 1 }, timeoutSeconds: 1800, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await prospectingEngine.executeRun(request.data.runId);
  }
);

/* =========================================================================
   AGENTE DE OUTBOUND — transforma leads qualificados (achados pela
   Prospecção IA acima, ou cadastrados manualmente) em abordagens comerciais
   personalizadas, SEM enviar nada automaticamente (ver CLAUDE.md "Agente de
   Outbound"). Reaproveita o Lead existente (leads/{leadId}, nunca um segundo
   cadastro de prospect) e o MESMO ClaudeProvider da Prospecção IA (nunca uma
   segunda integração Claude). CRUD/ações restritos a Platform
   Administrator/Owner, mesma garantia estrutural das seções acima.
   ========================================================================= */

exports.updateSalesContext = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const result = await salesContextService.updateSalesContext(data || {}, { updatedBy: caller.uid });
  await writePlatformAuditLog('outbound_sales_context_atualizado', { campos: Object.keys(data || {}) }, context);
  console.log(`updateSalesContext: por caller=${caller.uid}`);
  return result;
});

// Geração individual — "Gerar abordagem com IA" no Lead. Síncrona (1-3
// chamadas Claude) — cabe folgado no teto de 9min do Gen 1, sem precisar do
// desenho request/execute do lote abaixo.
exports.generateOutboundMessage = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  const channel = data?.channel || 'email';
  const allowResearch = data?.allowResearch === true;
  const result = await outboundEngine.generateForLead(leadId, { channel, allowResearch, createdBy: caller.uid });
  await writePlatformAuditLog('outbound_mensagem_gerada', { leadId, status: result.status, channel }, context);
  console.log(`generateOutboundMessage: leadId=${leadId} status=${result.status} por caller=${caller.uid}`);
  if (result.status === 'failed') {
    throw new functions.https.HttpsError('internal', `Falha ao gerar abordagem: ${result.error}`);
  }
  return result;
});

// Enfileira a task que dispara executeOutboundBatch — mesmo mecanismo de
// enqueueProspectingRun acima (ver comentário no topo do arquivo).
async function enqueueOutboundBatch(batchId) {
  await cloudTasksDispatcher.enqueueCloudTask({ queueName: 'executeOutboundBatch', payload: { batchId } });
}

// Geração em lote — deliberadamente RÁPIDO (mesmo padrão de
// requestProspectingRun): só cria o doc de lote com status "queued" e
// enfileira a task; executeOutboundBatch (abaixo) roda de verdade. Cliente
// acompanha via onSnapshot em outboundBatches/{batchId}. Nunca gera pra leads
// não selecionados explicitamente (CLAUDE.md "Geração em lote").
exports.requestOutboundBatch = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const result = await outboundEngine.requestBatch({
    leadIds: Array.isArray(data?.leadIds) ? data.leadIds : [],
    channel: data?.channel || 'email',
    allowResearch: data?.allowResearch === true,
    requestedBy: caller.uid,
  });
  await enqueueOutboundBatch(result.batchId);
  await writePlatformAuditLog('outbound_lote_solicitado', { batchId: result.batchId, total: result.total }, context);
  console.log(`requestOutboundBatch: batchId=${result.batchId} total=${result.total} por caller=${caller.uid}`);
  return result;
});

// Motor de lote de verdade — task queue function pelo mesmo motivo de
// executeProspectingRun (um lote de muitos leads pode passar do teto de 9min
// de gatilho de evento). Disparado pela TASK enfileirada por
// requestOutboundBatch logo após criar o doc "queued"; sem retry automático
// pelo mesmo motivo (progresso incremental, ver executeProspectingRun).
exports.executeOutboundBatch = onTaskDispatched(
  { retryConfig: { maxAttempts: 1 }, timeoutSeconds: 1800, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await outboundEngine.executeBatch(request.data.batchId);
  }
);

exports.approveOutboundMessage = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  await outboundMessagesService.setDecision(leadId, 'approved', { reviewedBy: caller.uid });
  await writePlatformAuditLog('outbound_mensagem_aprovada', { leadId }, context);
  console.log(`approveOutboundMessage: leadId=${leadId} por caller=${caller.uid}`);
  return { success: true };
});

exports.rejectOutboundMessage = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  await outboundMessagesService.setDecision(leadId, 'rejected', { reviewedBy: caller.uid });
  await writePlatformAuditLog('outbound_mensagem_rejeitada', { leadId }, context);
  console.log(`rejectOutboundMessage: leadId=${leadId} por caller=${caller.uid}`);
  return { success: true };
});

// Preserva personalizationSummary/motivos/evidence da versão atual — o
// comercial edita texto (subject/message/cta), nunca re-digita evidências
// que a IA coletou (CLAUDE.md "Edição Humana").
exports.editOutboundMessage = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  const message = String(data?.message || '').trim();
  if (!message) throw new functions.https.HttpsError('invalid-argument', 'message não pode ficar vazio.');

  const currentSnap = await db.collection('outboundMessages').doc(leadId).get();
  if (!currentSnap.exists) throw new functions.https.HttpsError('not-found', `Abordagem para o lead "${leadId}" não existe.`);
  const current = currentSnap.data();

  const { versionId } = await outboundMessagesService.recordVersion(leadId, {
    source: 'human_edited', trigger: 'edit',
    subject: data?.subject != null ? String(data.subject) : current.subject,
    message,
    cta: data?.cta != null ? String(data.cta) : current.cta,
    personalizationSummary: current.personalizationSummary,
    motivos: current.motivos,
    evidence: current.evidence,
    createdBy: caller.uid,
  });
  await writePlatformAuditLog('outbound_mensagem_editada', { leadId, versionId }, context);
  console.log(`editOutboundMessage: leadId=${leadId} por caller=${caller.uid}`);
  return { versionId };
});

// Marca como enviada MANUALMENTE pelo comercial — nunca disparado por envio
// automático (CLAUDE.md "Importante: não enviar automaticamente"). Prepara a
// arquitetura pra um futuro envio real por canal, sem implementá-lo agora.
exports.markOutboundMessageSent = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  await outboundMessagesService.markSent(leadId, { sentBy: caller.uid });
  await writePlatformAuditLog('outbound_mensagem_marcada_enviada', { leadId }, context);
  console.log(`markOutboundMessageSent: leadId=${leadId} por caller=${caller.uid}`);
  return { success: true };
});

exports.markOutboundMessageResponded = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const leadId = String(data?.leadId || '').trim();
  if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
  await outboundMessagesService.markResponded(leadId);
  await writePlatformAuditLog('outbound_mensagem_marcada_respondida', { leadId }, context);
  console.log(`markOutboundMessageResponded: leadId=${leadId} por caller=${caller.uid}`);
  return { success: true };
});

/* =========================================================================
   BOTÃO "EXECUTAR OUTBOUND IA" — dispara o Outbound remotamente via GitHub
   Actions (Claude Code + Claude Pro, nunca Anthropic API/API billing). Ver
   CLAUDE.md "Botão Executar Outbound IA", lib/outbound/remoteRuns.js
   (controle de concorrência) e .github/workflows/outbound-weekly.yml (quem
   roda de verdade). O cliente acompanha outboundRemoteRuns/{runId} via
   onSnapshot (Firestore Rules: read isPlatformAdministrator(), write:false —
   mesma garantia estrutural do resto deste arquivo).
   ========================================================================= */

const OUTBOUND_REMOTE_MAX_LEADS = 20;

// Só leitura — calcula os números pro modal de confirmação ("Serão
// processados: N"), sem reivindicar o lock nem disparar nada ainda.
exports.previewOutboundRemoteRun = functions.https.onCall(async (data, context) => {
  await platformAuth.requirePlatformAdministrator(context);
  const { totalQualificados, jaAbordados, elegiveis } = await getEligibleLeads({ db, limit: OUTBOUND_REMOTE_MAX_LEADS });
  const lockSnap = await db.collection('outboundRemoteRuns').doc(remoteRunsService.LOCK_DOC_ID).get();
  const lock = lockSnap.exists ? lockSnap.data() : null;
  const updatedAtMs = lock?.updatedAt?.toMillis ? lock.updatedAt.toMillis() : 0;
  const isRunning = lock && ['pending', 'running'].includes(lock.status) && (Date.now() - updatedAtMs) <= remoteRunsService.RUNNING_STALE_MS;
  return {
    totalQualificados, jaAbordados, elegiveis,
    seraoProcessados: Math.min(elegiveis, OUTBOUND_REMOTE_MAX_LEADS),
    jaExisteExecucaoEmAndamento: !!isRunning,
  };
});

// Reivindica o lock, cria o doc de execução e dispara o workflow do GitHub
// Actions — RÁPIDO (mesmo raciocínio de requestProspectingRun): quem gera as
// abordagens de verdade é o runner do GitHub Actions, não esta function.
exports.requestOutboundRemoteRun = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);

  const { totalQualificados, jaAbordados, selecionados } = await getEligibleLeads({ db, limit: OUTBOUND_REMOTE_MAX_LEADS });
  if (!selecionados.length) {
    throw new functions.https.HttpsError('failed-precondition', 'Nenhum lead elegível pra Outbound no momento.');
  }
  const leadIdsPlanned = selecionados.map((lead) => lead.id);

  const { runId } = await remoteRunsService.requestRun({
    leadIdsPlanned, totalQualificados, jaAbordados,
    requestedBy: caller.uid, requestedByEmail: context.auth?.token?.email || null,
  });

  try {
    await githubDispatchService.dispatchOutboundWorkflow({ runId, maxLeads: OUTBOUND_REMOTE_MAX_LEADS });
  } catch (e) {
    // Se o disparo falhar, o run nunca chega a rodar — libera o lock na hora
    // em vez de deixar "pending" travado até o self-heal por staleness.
    await remoteRunsService.markFinished(runId, 'failed', { error: `Falha ao disparar o GitHub Actions: ${e.message}` });
    throw e;
  }

  await writePlatformAuditLog('outbound_remote_run_solicitado', { runId, leadIds: leadIdsPlanned }, context);
  console.log(`requestOutboundRemoteRun: runId=${runId} leads=${leadIdsPlanned.length} por caller=${caller.uid}`);
  return { runId, leadsPlanejados: leadIdsPlanned.length };
});
