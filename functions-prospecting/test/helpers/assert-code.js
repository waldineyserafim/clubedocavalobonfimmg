// functions/test/helpers/assert-code.js — assert.rejects casa contra err.message
// por padrão; functions.https.HttpsError guarda o código ('permission-denied',
// 'not-found', ...) em err.code, separado da mensagem. Este helper checa o code.
const assert = require('assert');

async function assertRejectsWithCode(promiseOrFn, expectedCode, msg) {
  let threw = null;
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, msg || `esperava rejeição com code="${expectedCode}", mas não rejeitou`);
  assert.strictEqual(threw.code, expectedCode, `${msg || ''} — code esperado "${expectedCode}", recebido "${threw.code}" (mensagem: ${threw.message})`.trim());
}

module.exports = { assertRejectsWithCode };
