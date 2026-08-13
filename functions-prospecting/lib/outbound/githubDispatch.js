// functions/lib/outbound/githubDispatch.js — dispara o workflow do GitHub
// Actions que roda o Claude Code (ver CLAUDE.md "Botão Executar Outbound
// IA" e .github/workflows/outbound-weekly.yml). Único ponto do backend que
// fala com a API do GitHub — usa `fetch()` nativo, mesmo padrão de
// lib/prospecting/claudeProvider.js/lib/billing/asaas.js, nenhuma
// dependência nova.
//
// O token de disparo (`github-actions-dispatch-token`, Secret Manager)
// nunca é logado nem devolvido ao chamador — só usado no header Authorization
// desta chamada.

const functions = require('firebase-functions');

const GITHUB_API_URL = 'https://api.github.com';
const REPO_OWNER = 'waldineyserafim';
const REPO_NAME = 'clubedocavalobonfimmg';
const WORKFLOW_FILE = 'outbound-weekly.yml';
const REF = 'main';

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken — lazy, lido do Secret Manager por quem chama
 * @param {typeof fetch} [opts.fetchImpl]
 */
function createGithubDispatchService({ getToken, fetchImpl = fetch } = {}) {
  if (!getToken) throw new Error('createGithubDispatchService: getToken é obrigatório.');

  /**
   * Dispara o workflow_dispatch com os inputs {runId, maxLeads}. GitHub não
   * devolve o run id do Actions síncronamente (a API de dispatch é
   * fire-and-forget, 204 No Content) — por isso o rastreamento de progresso
   * é feito pelo doc outboundRemoteRuns/{runId}, nunca pela resposta desta chamada.
   * @param {{runId: string, maxLeads: number}} params
   */
  async function dispatchOutboundWorkflow({ runId, maxLeads }) {
    const token = await getToken();
    const response = await fetchImpl(
      `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          'accept': 'application/vnd.github+json',
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ ref: REF, inputs: { runId, maxLeads: String(maxLeads) } }),
      }
    );
    if (response.status !== 204) {
      const body = await response.text().catch(() => '');
      throw new functions.https.HttpsError('unavailable', `GitHub Actions dispatch falhou (HTTP ${response.status}): ${body.slice(0, 300)}`);
    }
  }

  return { dispatchOutboundWorkflow };
}

module.exports = { createGithubDispatchService, REPO_OWNER, REPO_NAME, WORKFLOW_FILE };
