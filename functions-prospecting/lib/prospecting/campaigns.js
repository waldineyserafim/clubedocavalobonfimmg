// functions/lib/prospecting/campaigns.js — CRUD de campanhas de Prospecção
// IA (prospectingCampaigns/{campaignId}). Mesmo padrão de DI/estilo de
// lib/features.js e lib/leads.js: factory, sem import de firebase-admin,
// validação de payload aqui, execução em lib/prospecting/engine.js.
//
// Contrato (prospectingCampaigns/{campaignId}):
//   name, description, status: "active"|"paused"|"archived"
//   icp: { segmento[], localizacao{estados[],cidades[],regiao}, porte,
//          caracteristicasDesejadas[], caracteristicasObrigatorias[],
//          caracteristicasExclusao[], palavrasChave[], sinaisOportunidade[],
//          perfilDecisor }
//   research: { fontesPermitidas[], termosBase[], profundidade, criteriosValidacao[] }
//   qualification: { criteriosLeadQuente[], scoreMinimo, dadosObrigatorios[], evidenciasObrigatorias }
//   execution: { frequencia: "weekly"|"manual", maxLeadsPerRun, maxIterations,
//                maxCandidatesProcessed, timeoutSeconds, limiteConsumoUsd,
//                horarioPreferencial }
//   campaignStatus: "idle"|"running" — lock operacional (ver engine.js),
//     nunca editado pelas funções deste arquivo, só pelo motor de execução
//   lastRunAt, lastRunSummary — preenchidos pelo motor ao final de cada execução
//   createdAt, updatedAt, createdBy

const functions = require('firebase-functions');

const STATUSES = ['active', 'paused', 'archived'];
const FREQUENCIAS = ['weekly', 'manual'];

// Valores padrão da primeira versão (CLAUDE.md, "Configuração padrão da
// primeira versão") — editáveis por campanha, nunca hard-coded no motor.
const DEFAULT_EXECUTION = {
  frequencia: 'weekly',
  maxLeadsPerRun: 20,
  maxIterations: 5,
  maxCandidatesProcessed: 100,
  timeoutSeconds: 1500, // 25min — margem sob o timeout de 30min da Cloud Function do motor
  limiteConsumoUsd: 5,
  horarioPreferencial: '08:00',
};
const DEFAULT_QUALIFICATION = {
  criteriosLeadQuente: [],
  scoreMinimo: 70,
  dadosObrigatorios: ['contatoWhatsapp'],
  evidenciasObrigatorias: 1,
};

function strArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function sanitizeIcp(icp = {}) {
  return {
    segmento: strArray(icp.segmento),
    localizacao: {
      estados: strArray(icp.localizacao?.estados),
      cidades: strArray(icp.localizacao?.cidades),
      regiao: String(icp.localizacao?.regiao || '').trim(),
    },
    porte: String(icp.porte || '').trim(),
    caracteristicasDesejadas: strArray(icp.caracteristicasDesejadas),
    caracteristicasObrigatorias: strArray(icp.caracteristicasObrigatorias),
    caracteristicasExclusao: strArray(icp.caracteristicasExclusao),
    palavrasChave: strArray(icp.palavrasChave),
    sinaisOportunidade: strArray(icp.sinaisOportunidade),
    perfilDecisor: String(icp.perfilDecisor || '').trim(),
  };
}

function sanitizeResearch(research = {}) {
  return {
    fontesPermitidas: strArray(research.fontesPermitidas),
    termosBase: strArray(research.termosBase),
    profundidade: String(research.profundidade || 'padrao').trim(),
    criteriosValidacao: strArray(research.criteriosValidacao),
  };
}

function sanitizeQualification(qualification = {}) {
  const scoreMinimo = Number(qualification.scoreMinimo);
  const evidenciasObrigatorias = Number(qualification.evidenciasObrigatorias);
  return {
    criteriosLeadQuente: strArray(qualification.criteriosLeadQuente),
    scoreMinimo: Number.isFinite(scoreMinimo) ? Math.min(100, Math.max(0, Math.trunc(scoreMinimo))) : DEFAULT_QUALIFICATION.scoreMinimo,
    dadosObrigatorios: strArray(qualification.dadosObrigatorios),
    evidenciasObrigatorias: Number.isFinite(evidenciasObrigatorias) ? Math.max(0, Math.trunc(evidenciasObrigatorias)) : DEFAULT_QUALIFICATION.evidenciasObrigatorias,
  };
}

function sanitizeExecution(execution = {}) {
  const frequencia = FREQUENCIAS.includes(execution.frequencia) ? execution.frequencia : DEFAULT_EXECUTION.frequencia;
  const clampInt = (v, fallback, min, max) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    frequencia,
    // "até 20 leads" — nunca reduz o critério de qualidade pra atingir a meta
    // (ver CLAUDE.md), este número é só o TETO superior de uma execução.
    maxLeadsPerRun: clampInt(execution.maxLeadsPerRun, DEFAULT_EXECUTION.maxLeadsPerRun, 1, 100),
    maxIterations: clampInt(execution.maxIterations, DEFAULT_EXECUTION.maxIterations, 1, 15),
    maxCandidatesProcessed: clampInt(execution.maxCandidatesProcessed, DEFAULT_EXECUTION.maxCandidatesProcessed, 1, 500),
    timeoutSeconds: clampInt(execution.timeoutSeconds, DEFAULT_EXECUTION.timeoutSeconds, 60, 1740), // teto sob os 1800s (30min) da function do motor
    limiteConsumoUsd: Number.isFinite(Number(execution.limiteConsumoUsd)) ? Math.max(0.1, Number(execution.limiteConsumoUsd)) : DEFAULT_EXECUTION.limiteConsumoUsd,
    horarioPreferencial: String(execution.horarioPreferencial || DEFAULT_EXECUTION.horarioPreferencial).trim(),
  };
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {string} [opts.collectionName="prospectingCampaigns"]
 */
function createCampaignsService({ db, serverTimestamp, collectionName = 'prospectingCampaigns' } = {}) {
  if (!db) throw new Error('createCampaignsService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createCampaignsService: serverTimestamp é obrigatório.');
  const col = () => db.collection(collectionName);

  async function createCampaign(fields = {}, { createdBy } = {}) {
    if (!createdBy) throw new functions.https.HttpsError('invalid-argument', 'createdBy é obrigatório.');
    const name = String(fields.name || '').trim();
    if (!name) throw new functions.https.HttpsError('invalid-argument', 'name é obrigatório.');

    const docData = {
      name,
      description: String(fields.description || '').trim(),
      status: 'active', // "Status: Ativo" é o padrão da primeira versão — nunca nasce pausada sem pedido explícito
      icp: sanitizeIcp(fields.icp),
      research: sanitizeResearch(fields.research),
      qualification: sanitizeQualification(fields.qualification),
      execution: sanitizeExecution(fields.execution),
      campaignStatus: 'idle', // lock operacional — só o motor de execução escreve isto depois de criada
      lastRunAt: null,
      lastRunSummary: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy,
    };
    const ref = await col().add(docData);
    return { id: ref.id };
  }

  async function updateCampaign(id, fields = {}) {
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Campanha "${id}" não existe.`);

    const update = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
    if (has('name')) {
      const v = String(fields.name || '').trim();
      if (!v) throw new functions.https.HttpsError('invalid-argument', 'name não pode ficar vazio.');
      update.name = v;
    }
    if (has('description')) update.description = String(fields.description || '').trim();
    if (has('icp')) update.icp = sanitizeIcp(fields.icp);
    if (has('research')) update.research = sanitizeResearch(fields.research);
    if (has('qualification')) update.qualification = sanitizeQualification(fields.qualification);
    if (has('execution')) update.execution = sanitizeExecution(fields.execution);

    update.updatedAt = serverTimestamp();
    await ref.update(update);
  }

  /** value: "active" | "paused" — nunca "archived" por aqui (ver archiveCampaign, que é a única porta pra esse estado terminal). */
  async function setStatus(id, value) {
    if (!['active', 'paused'].includes(value)) {
      throw new functions.https.HttpsError('invalid-argument', 'status precisa ser "active" ou "paused".');
    }
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Campanha "${id}" não existe.`);
    await ref.update({ status: value, updatedAt: serverTimestamp() });
  }

  async function archiveCampaign(id) {
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Campanha "${id}" não existe.`);
    await ref.update({ status: 'archived', updatedAt: serverTimestamp() });
  }

  return { createCampaign, updateCampaign, setStatus, archiveCampaign };
}

module.exports = {
  createCampaignsService,
  STATUSES,
  FREQUENCIAS,
  DEFAULT_EXECUTION,
  DEFAULT_QUALIFICATION,
};
