// functions/lib/cloudTasksDispatch.js — enfileira tasks no Cloud Tasks via
// REST direto, NÃO via `getFunctions().taskQueue(...).enqueue()`
// (firebase-admin/functions).
//
// Achado real (não hipótese): o wrapper `getFunctions().taskQueue()` falha
// consistentemente neste ambiente com "Queue does not exist" — confirmado
// tanto na Cloud Function real deployada quanto localmente, mesmo com IAM
// correto (roles/run.invoker no Cloud Run alvo + roles/cloudtasks.enqueuer
// na service account chamadora, ambos verificados). Reproduzindo a MESMA
// chamada como REST puro (POST cloudtasks.googleapis.com/v2/.../tasks,
// mesmo payload, mesma identidade OIDC) funciona — a falha está isolada ao
// SDK, não à infraestrutura/permissões. Por isso este módulo chama a API
// REST diretamente, mesmo padrão de fetch() já usado em
// lib/outbound/githubDispatch.js e lib/prospecting/claudeProvider.js, sem
// dependência nova (google-auth-library já é dependência direta).
//
// Usado por enqueueProspectingRun/enqueueOutboundBatch em index.js — troca
// só o MECANISMO de enfileiramento, nunca a lógica de negócio (motores de
// execução continuam idênticos, lendo request.data.runId/batchId como já liam).

const functions = require('firebase-functions');

const PROJECT_ID = 'clubecavalobonfim';
const SERVICE_ACCOUNT_EMAIL = `${PROJECT_ID}@appspot.gserviceaccount.com`;
const CLOUD_TASKS_API_URL = 'https://cloudtasks.googleapis.com/v2';

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getAccessToken — lazy, token OAuth da service account chamadora
 * @param {typeof fetch} [opts.fetchImpl]
 */
function createCloudTasksDispatcher({ getAccessToken, fetchImpl = fetch } = {}) {
  if (!getAccessToken) throw new Error('createCloudTasksDispatcher: getAccessToken é obrigatório.');

  /**
   * @param {object} params
   * @param {string} params.queueName — mesmo nome da fila E da task queue function alvo (onTaskDispatched)
   * @param {string} [params.region="us-central1"]
   * @param {object} params.payload — vira `request.data` na função alvo (ex.: {runId} ou {batchId})
   */
  async function enqueueCloudTask({ queueName, region = 'us-central1', payload }) {
    const accessToken = await getAccessToken();
    const targetUrl = `https://${region}-${PROJECT_ID}.cloudfunctions.net/${queueName}`;
    const body = {
      task: {
        httpRequest: {
          url: targetUrl,
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ data: payload })).toString('base64'),
          oidcToken: { serviceAccountEmail: SERVICE_ACCOUNT_EMAIL },
        },
      },
    };

    const response = await fetchImpl(`${CLOUD_TASKS_API_URL}/projects/${PROJECT_ID}/locations/${region}/queues/${queueName}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new functions.https.HttpsError('unavailable', `Cloud Tasks enqueue falhou (HTTP ${response.status}): ${errBody.slice(0, 300)}`);
    }
  }

  return { enqueueCloudTask };
}

module.exports = { createCloudTasksDispatcher, SERVICE_ACCOUNT_EMAIL };
