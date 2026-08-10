// functions/lib/authBackup.js — backup semanal do Firebase Auth (Fase 3.6,
// Etapa 11 do Deploy Controlado).
//
// Firestore já tem Point-in-Time Recovery habilitado (7 dias) desde o
// hardening da Fase 3.6; Auth não tem nenhum produto equivalente de backup
// automático da Google — a única forma de recuperação de desastre é um
// export próprio. Grava o snapshot bruto de admin.auth().listUsers() (inclui
// passwordHash/passwordSalt — sem eles a restauração recriaria contas com
// senhas diferentes, obrigando reset em massa) como JSON no mesmo bucket do
// Storage já existente, sob backups/auth/ — sem bucket novo, sem custo
// adicional de infraestrutura. Retenção de 90 dias via lifecycle rule do
// próprio bucket (ver Etapa 11 do relatório de deploy), não neste código.

async function exportAllUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users.map((u) => u.toJSON()));
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

/**
 * @param {object} opts
 * @param {import('firebase-admin').auth.Auth} opts.auth
 * @param {import('@google-cloud/storage').Bucket} opts.bucket
 * @returns {Promise<{count: number, path: string}>}
 */
async function runAuthBackup({ auth, bucket }) {
  const users = await exportAllUsers(auth);
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const path = `backups/auth/${dateStr}.json`;

  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: users.length, users }, null, 0);
  await bucket.file(path).save(payload, { contentType: 'application/json' });

  return { count: users.length, path };
}

module.exports = { runAuthBackup };
