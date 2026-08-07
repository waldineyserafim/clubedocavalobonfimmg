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

module.exports = { getApp, seedOrganization, seedUser };
