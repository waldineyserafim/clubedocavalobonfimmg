// functions/test/cloud-tasks-dispatch.test.js — lib/cloudTasksDispatch.js,
// com getAccessToken/fetchImpl mockados (nunca chama a API real do Cloud
// Tasks). Cobre o achado real desta fase: o payload precisa ter exatamente
// o formato {data: payload} em base64 e oidcToken.serviceAccountEmail
// correto, ou o onTaskDispatched alvo não consegue ler request.data.
const assert = require('assert');
const { createCloudTasksDispatcher } = require('../lib/cloudTasksDispatch');

module.exports = async function run({ t }) {
  await t('enqueueCloudTask: monta a URL, o body {data:payload} em base64 e o oidcToken corretos', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true };
    };
    const dispatcher = createCloudTasksDispatcher({ getAccessToken: async () => 'fake-access-token', fetchImpl });

    await dispatcher.enqueueCloudTask({ queueName: 'executeProspectingRun', payload: { runId: 'abc123' } });

    assert.strictEqual(captured.url, 'https://cloudtasks.googleapis.com/v2/projects/clubecavalobonfim/locations/us-central1/queues/executeProspectingRun/tasks');
    assert.strictEqual(captured.init.headers.authorization, 'Bearer fake-access-token');
    const body = JSON.parse(captured.init.body);
    assert.strictEqual(body.task.httpRequest.url, 'https://us-central1-clubecavalobonfim.cloudfunctions.net/executeProspectingRun');
    assert.strictEqual(body.task.httpRequest.oidcToken.serviceAccountEmail, 'clubecavalobonfim@appspot.gserviceaccount.com');
    const decodedBody = JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString());
    assert.deepStrictEqual(decodedBody, { data: { runId: 'abc123' } });
  });

  await t('enqueueCloudTask: respeita queueName/payload diferentes (executeOutboundBatch)', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => { captured = { url, init }; return { ok: true }; };
    const dispatcher = createCloudTasksDispatcher({ getAccessToken: async () => 'fake-access-token', fetchImpl });

    await dispatcher.enqueueCloudTask({ queueName: 'executeOutboundBatch', payload: { batchId: 'xyz789' } });

    assert.match(captured.url, /queues\/executeOutboundBatch\/tasks$/);
    const body = JSON.parse(captured.init.body);
    assert.strictEqual(body.task.httpRequest.url, 'https://us-central1-clubecavalobonfim.cloudfunctions.net/executeOutboundBatch');
    const decodedBody = JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString());
    assert.deepStrictEqual(decodedBody, { data: { batchId: 'xyz789' } });
  });

  await t('enqueueCloudTask: HTTP não-ok vira HttpsError "unavailable"', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '{"error":{"message":"Queue does not exist."}}' });
    const dispatcher = createCloudTasksDispatcher({ getAccessToken: async () => 'fake-access-token', fetchImpl });

    await assert.rejects(
      () => dispatcher.enqueueCloudTask({ queueName: 'executeProspectingRun', payload: { runId: 'x' } }),
      (err) => {
        assert.strictEqual(err.code, 'unavailable');
        assert.match(err.message, /404/);
        return true;
      }
    );
  });

  await t('enqueueCloudTask: nunca inclui o access token no corpo da requisição, só no header', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => { captured = init; return { ok: true }; };
    const dispatcher = createCloudTasksDispatcher({ getAccessToken: async () => 'super-secret-access-token', fetchImpl });

    await dispatcher.enqueueCloudTask({ queueName: 'executeProspectingRun', payload: { runId: 'y' } });

    assert.ok(!captured.body.includes('super-secret-access-token'), 'o token nunca pode aparecer no corpo da requisição');
  });
};
