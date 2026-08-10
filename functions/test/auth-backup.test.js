// Testa runAuthBackup (Fase 3.6, Etapa 11 do Deploy Controlado) — usa o Auth
// Emulator de verdade (listUsers real) e um bucket fake em memória (sem
// Storage Emulator no harness, ver test/run-all.js), só pra confirmar o
// contrato: conta bate, JSON é válido, path segue o padrão esperado.
const assert = require('assert');
const { runAuthBackup } = require('../lib/authBackup');

function fakeBucket() {
  const saved = {};
  return {
    file(path) {
      return {
        async save(content, _opts) {
          saved[path] = content;
        },
      };
    },
    _saved: saved,
  };
}

module.exports = async function run({ authInstance, t }) {
  await authInstance.createUser({ uid: 'authbackup_user_1', email: 'authbackup1@teste.local', password: 'senha123456' });
  await authInstance.createUser({ uid: 'authbackup_user_2', email: 'authbackup2@teste.local', password: 'senha123456' });

  await t('runAuthBackup: exporta usuários reais e grava no path esperado', async () => {
    const bucket = fakeBucket();
    const { count, path } = await runAuthBackup({ auth: authInstance, bucket });

    assert.ok(count >= 2, 'deveria contar pelo menos os 2 usuários criados neste teste');
    assert.match(path, /^backups\/auth\/\d{4}-\d{2}-\d{2}\.json$/, 'path deveria seguir backups/auth/YYYY-MM-DD.json');
    assert.ok(bucket._saved[path], 'arquivo deveria ter sido gravado no path retornado');

    const parsed = JSON.parse(bucket._saved[path]);
    assert.strictEqual(parsed.count, count);
    assert.ok(Array.isArray(parsed.users));
    const uids = parsed.users.map((u) => u.uid);
    assert.ok(uids.includes('authbackup_user_1'));
    assert.ok(uids.includes('authbackup_user_2'));
  });

  await authInstance.deleteUser('authbackup_user_1').catch(() => {});
  await authInstance.deleteUser('authbackup_user_2').catch(() => {});
};
