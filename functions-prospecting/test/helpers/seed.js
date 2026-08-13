// functions/test/helpers/seed.js — helpers de seed para testes contra o emulador.
// Usa firebase-admin (já é dependência de produção do projeto) com credenciais
// falsas — só funciona porque FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST
// já devem estar setados pelo processo que chama isto (ver test/run-all.js).

const admin = require('firebase-admin');

let app;
function getApp() {
  if (!app) app = admin.initializeApp({ projectId: 'clubecavalobonfim' }, 'test-' + Date.now());
  return app;
}

async function seedOrganization(db, { id, nome, ativo = true, modules = {}, notificationEmails } = {}) {
  await db.collection('organizations').doc(id).set({
    id, nome, ativo, modules,
    ...(notificationEmails ? { notificationEmails } : {}),
  });
  return id;
}

async function seedUser(db, authInstance, { uid, cpf, orgId, role, nome, ativo = true, extra = {} }) {
  const email = `${cpf}@cpf.local`;
  await authInstance.createUser({ uid, email, password: 'senha123456' }).catch(async (e) => {
    if (e.code === 'auth/uid-already-exists') return;
    throw e;
  });
  await db.collection('users').doc(uid).set({
    cpf, orgId, role, nome: nome || `Teste ${role}`, ativo, email, ...extra,
  });
  return uid;
}

// Fase 3.2 — equipe de PLATAFORMA (platformAdmins/{uid}), nunca tem orgId.
// Recebe email de verdade (não CPF-sintético — contas de plataforma não são
// associados) para poder exercitar admin.auth().createUser() de verdade.
async function seedPlatformAdmin(db, authInstance, { uid, email, role, nome, ativo = true }) {
  await authInstance.createUser({ uid, email, password: 'senha123456' }).catch(async (e) => {
    if (e.code === 'auth/uid-already-exists') return;
    throw e;
  });
  await db.collection('platformAdmins').doc(uid).set({
    role, nome: nome || `Teste ${role}`, email, ativo,
    createdAt: new Date(), updatedAt: new Date(), createdBy: 'test-seed',
  });
  return uid;
}

// Release 2 — Leads (núcleo da plataforma, não tem orgId). overrides permite
// sobrescrever qualquer campo do doc (ex.: status/archived/proximaAcao) pra
// montar cenários de teste específicos sem passar pela Cloud Function.
async function seedLead(db, { id, organizacaoNome, ownerUid, responsavelUid, ...overrides } = {}) {
  await db.collection('leads').doc(id).set({
    organizacaoNome: organizacaoNome || 'Organização de Teste',
    segmento: null, cidade: '', estado: '',
    contatoNome: '', contatoCargo: '', contatoWhatsapp: '', contatoEmail: '',
    status: 'novo', origem: null,
    responsavelUid: responsavelUid || ownerUid || 'test-owner',
    prioridade: 'media',
    dores: '', necessidades: '', observacoes: '',
    sistemaAtual: 'nenhum', sistemaAtualNome: '',
    associadosEstimados: null,
    proximaAcao: { tipo: null, data: null, descricao: '', concluida: false },
    ownerUid: ownerUid || 'test-owner',
    archived: false,
    ultimaInteracao: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

// Fase Pricing — catálogo de módulos. overrides permite sobrescrever
// economicValue/dependencies/active pra montar cenários específicos.
async function seedModuleCatalog(db, { key, label, economicValue = 0, dependencies = [], active = true, ...overrides } = {}) {
  await db.collection('moduleCatalog').doc(key).set({
    key, label: label || key, description: '', economicValue, dependencies, active,
    order: 0, createdAt: new Date(), updatedAt: new Date(), createdBy: 'test-seed', updatedBy: 'test-seed',
    ...overrides,
  });
  return key;
}

// Fase Pricing — systemPlans. modules aceita tanto array quanto map
// {chave:boolean}, normalizado pro map (mesmo shape que createPlan grava).
async function seedPlan(db, { id, price = null, modules = {}, isCustom = false, active = true, ...overrides } = {}) {
  const modulesMap = Array.isArray(modules) ? Object.fromEntries(modules.map((k) => [k, true])) : modules;
  await db.collection('systemPlans').doc(id).set({
    label: overrides.label || id, description: '', price, order: 0, recommended: false, isCustom,
    modules: modulesMap, limits: { maxAssociados: null, maxAdmins: null }, active,
    createdAt: new Date(), updatedAt: new Date(), createdBy: 'test-seed', updatedBy: 'test-seed',
    ...overrides,
  });
  return id;
}

// Fase Pricing — organizationSubscriptions (ledger de billing SaaS + isenção por organização).
async function seedSubscription(db, { orgId, plan = null, valorMensal = null, ...overrides } = {}) {
  await db.collection('organizationSubscriptions').doc(orgId).set({
    orgId, plan, valorMensal, status: 'ativa',
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });
  return orgId;
}

// Prospecção IA — campanha (núcleo da plataforma, não tem orgId, ver
// lib/prospecting/campaigns.js). overrides permite sobrescrever qualquer
// campo (status, campaignStatus, execution.*, updatedAt) pra montar cenários
// de lock/staleness sem passar pela Cloud Function.
async function seedProspectingCampaign(db, { id, name, createdBy, ...overrides } = {}) {
  await db.collection('prospectingCampaigns').doc(id).set({
    name: name || 'Campanha de Teste',
    description: '', status: 'active',
    icp: { segmento: ['clube'], localizacao: { estados: [], cidades: [], regiao: '' }, porte: '', caracteristicasDesejadas: [], caracteristicasObrigatorias: [], caracteristicasExclusao: [], palavrasChave: [], sinaisOportunidade: [], perfilDecisor: '' },
    research: { fontesPermitidas: [], termosBase: [], profundidade: 'padrao', criteriosValidacao: [] },
    qualification: { criteriosLeadQuente: [], scoreMinimo: 70, dadosObrigatorios: [], evidenciasObrigatorias: 1 },
    execution: { frequencia: 'weekly', maxLeadsPerRun: 20, maxIterations: 5, maxCandidatesProcessed: 100, timeoutSeconds: 1500, limiteConsumoUsd: 5, horarioPreferencial: '08:00' },
    campaignStatus: 'idle',
    lastRunAt: null, lastRunSummary: null,
    createdAt: new Date(), updatedAt: new Date(),
    createdBy: createdBy || 'test-owner',
    ...overrides,
  });
  return id;
}

module.exports = {
  getApp, seedOrganization, seedUser, seedPlatformAdmin, seedLead,
  seedModuleCatalog, seedPlan, seedSubscription, seedProspectingCampaign,
};
