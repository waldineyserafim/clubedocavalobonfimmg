// functions/lib/roles.js — mecanismo genérico de normalização de papel, do lado servidor.
//
// Mesmo contrato de shared/core/auth/roles.js (repositório portal-associativo, lado
// cliente) — de propósito: cliente e servidor usam o MESMO mecanismo (uma função que
// testa regras em ordem sobre uma string normalizada), só que cada lado injeta o
// vocabulário de papel que já usava. Isso elimina a duplicação encontrada na
// auditoria (mapRoleServer() reimplementava a mesma lógica com um bug — não tinha
// ramo para "adminView", então um usuário Admin View virava "admin" pleno do lado
// servidor, quando do lado cliente ele é somente-leitura).
//
// O núcleo NÃO conhece vocabulário nenhum (nem "master", nem "associado") — quem
// chama (index.js) define as regras, na mesma ordem que firebase.js já usa.

function normalize(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * @param {Array<[roleName: string, test: (normalized: string) => boolean]>} rules
 *   Testadas em ordem — a primeira que casar decide o papel.
 * @param {string} fallbackRole
 * @returns {(raw: string) => string} mapRole
 */
function createRoleResolver(rules, fallbackRole) {
  return function mapRole(raw) {
    const normalized = normalize(raw);
    for (const [roleName, test] of rules) {
      if (test(normalized)) return roleName;
    }
    return fallbackRole;
  };
}

module.exports = { createRoleResolver, normalize };
