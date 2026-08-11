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

module.exports = { getApp, seedOrganization, seedUser, seedPlatformAdmin, seedLead };
