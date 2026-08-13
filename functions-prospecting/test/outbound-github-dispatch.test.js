// functions/test/outbound-github-dispatch.test.js — lib/outbound/githubDispatch.js
// com fetchImpl mockado — NUNCA chama a API real do GitHub (evita disparar
// um workflow de verdade durante a suíte de testes).
const assert = require('assert');
const { createGithubDispatchService } = require('../lib/outbound/githubDispatch');

module.exports = async function run({ t }) {
  await t('dispatchOutboundWorkflow: chama o endpoint correto com ref/inputs corretos e token no header Authorization', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 204 };
    };
    const service = createGithubDispatchService({ getToken: async () => 'fake-github-token', fetchImpl });

    await service.dispatchOutboundWorkflow({ runId: 'run_abc', maxLeads: 20 });

    assert.strictEqual(captured.url, 'https://api.github.com/repos/waldineyserafim/clubedocavalobonfimmg/actions/workflows/outbound-weekly.yml/dispatches');
    assert.strictEqual(captured.init.method, 'POST');
    assert.strictEqual(captured.init.headers.authorization, 'Bearer fake-github-token');
    const body = JSON.parse(captured.init.body);
    assert.strictEqual(body.ref, 'main');
    assert.deepStrictEqual(body.inputs, { runId: 'run_abc', maxLeads: '20' });
  });

  await t('dispatchOutboundWorkflow: HTTP diferente de 204 vira HttpsError "unavailable"', async () => {
    const fetchImpl = async () => ({ status: 422, text: async () => '{"message":"Workflow does not have workflow_dispatch trigger"}' });
    const service = createGithubDispatchService({ getToken: async () => 'fake-github-token', fetchImpl });

    await assert.rejects(
      () => service.dispatchOutboundWorkflow({ runId: 'run_x', maxLeads: 20 }),
      (err) => {
        assert.strictEqual(err.code, 'unavailable');
        assert.match(err.message, /422/);
        return true;
      }
    );
  });

  await t('dispatchOutboundWorkflow: nunca inclui o token no corpo da requisição, só no header', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => { captured = init; return { status: 204 }; };
    const service = createGithubDispatchService({ getToken: async () => 'super-secret-token-value', fetchImpl });

    await service.dispatchOutboundWorkflow({ runId: 'run_y', maxLeads: 5 });

    assert.ok(!captured.body.includes('super-secret-token-value'), 'o token nunca pode aparecer no corpo da requisição');
  });
};
