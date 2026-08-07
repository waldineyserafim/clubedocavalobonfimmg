// Testa lib/roles.js — inclui a checagem do bug real encontrado na auditoria
// (mapRoleServer() não tinha ramo "adminView", então um Admin View virava
// "admin" pleno do lado servidor).
const assert = require('assert');
const { createRoleResolver } = require('../lib/roles');

const mapRole = createRoleResolver(
  [
    ['master', (n) => n.includes('master')],
    ['adminView', (n) => n.includes('admin') && n.includes('view')],
    ['admin', (n) => n.includes('admin')],
    ['operador', (n) => n.includes('operador')],
    ['participanteLeilao', (n) => n.includes('participante')],
  ],
  'associado'
);

module.exports = async function run({ t }) {
  const cases = [
    ['Master', 'master'],
    ['master', 'master'],
    ['Admin Master', 'master'], // master tem prioridade sobre admin
    ['Admin View', 'adminView'],
    ['admin view', 'adminView'],
    ['Admin', 'admin'],
    ['Administrador', 'admin'],
    ['Operador', 'operador'],
    ['Participante Leilão', 'participanteLeilao'],
    ['', 'associado'],
    ['Associado', 'associado'],
    [undefined, 'associado'],
  ];

  for (const [raw, expected] of cases) {
    await t(`mapRole(${JSON.stringify(raw)}) === "${expected}"`, async () => {
      assert.strictEqual(mapRole(raw), expected);
    });
  }

  await t('regressão do bug da auditoria: "Admin View" NÃO vira "admin" pleno', async () => {
    assert.notStrictEqual(mapRole('Admin View'), 'admin');
    assert.strictEqual(mapRole('Admin View'), 'adminView');
  });
};
