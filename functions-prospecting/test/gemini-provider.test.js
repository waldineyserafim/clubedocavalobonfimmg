// functions/test/gemini-provider.test.js — lib/prospecting/geminiProvider.js
// testado com fetchImpl mockado (nunca toca a Gemini API de verdade — mesmo
// "modo seguro de teste" do resto da suíte). Cobre: contrato de retorno
// (mesma forma que claudeProvider.researchIteration), duas chamadas por
// iteração (pesquisa + extração), groundingMetadata → searchesPerformed,
// resposta vazia/bloqueada, JSON malformado na extração, e o payload de
// requisição (tool google_search só na 1ª chamada, responseSchema só na 2ª).
const assert = require('assert');
const { createGeminiProvider } = require('../lib/prospecting/geminiProvider');

const CAMPAIGN = {
  icp: { segmento: ['clube'] },
  research: {},
  qualification: { scoreMinimo: 70 },
};
const ITERATION_CONTEXT = { leadsEncontrados: 0, metaLeads: 20, buscasAnteriores: [] };

function makeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      const response = responses[calls.length - 1];
      return {
        ok: true,
        json: async () => response,
      };
    },
  };
}

module.exports = async function run({ t }) {
  await t('researchIteration: faz 2 chamadas (pesquisa com google_search, depois extração com responseSchema)', async () => {
    const { calls, fetchImpl } = makeFetch([
      {
        candidates: [{ content: { parts: [{ text: 'Encontrei o Clube Teste, site clubeteste.com.br.' }] }, finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['clube equestre MG'] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 },
      },
      {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          candidates: [{ organizacaoNome: 'Clube Teste', score: 85, evidence: [{ url: 'https://clubeteste.com.br', informacaoExtraida: 'Site oficial ativo' }] }],
          buscaResumo: 'clube equestre MG',
        }) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80 },
      },
    ]);
    const provider = createGeminiProvider({ getApiKey: async () => 'fake-key', fetchImpl });

    const result = await provider.researchIteration(CAMPAIGN, ITERATION_CONTEXT);

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].body.tools, [{ google_search: {} }]);
    assert.strictEqual(calls[0].body.generationConfig.responseSchema, undefined, '1ª chamada não deve forçar schema junto com o tool');
    assert.strictEqual(calls[1].body.tools, undefined, '2ª chamada não deve reenviar o tool de busca');
    assert.ok(calls[1].body.generationConfig.responseSchema, '2ª chamada precisa pedir saída estruturada');

    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0].organizacaoNome, 'Clube Teste');
    assert.strictEqual(result.buscaResumo, 'clube equestre MG');
    assert.strictEqual(result.searchesPerformed, 1);
    assert.strictEqual(result.usage.inputTokens, 800);
    assert.strictEqual(result.usage.outputTokens, 180);
    assert.ok(result.costUsd > 0, 'custo estimado deveria contar tokens + o prompt com grounding');
  });

  await t('researchIteration: resposta vazia/bloqueada na 1ª chamada devolve 0 candidatos sem lançar exceção', async () => {
    const { fetchImpl } = makeFetch([
      { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0 } },
    ]);
    const provider = createGeminiProvider({ getApiKey: async () => 'fake-key', fetchImpl });

    const result = await provider.researchIteration(CAMPAIGN, ITERATION_CONTEXT);

    assert.deepStrictEqual(result.candidates, []);
    assert.strictEqual(result.stopReason, 'SAFETY');
  });

  await t('researchIteration: JSON malformado na extração devolve 0 candidatos sem lançar exceção (nunca derruba a execução)', async () => {
    const { fetchImpl } = makeFetch([
      { candidates: [{ content: { parts: [{ text: 'Achei um clube qualquer.' }] }, finishReason: 'STOP' }], usageMetadata: {} },
      { candidates: [{ content: { parts: [{ text: 'isto não é JSON válido {' }] }, finishReason: 'STOP' }], usageMetadata: {} },
    ]);
    const provider = createGeminiProvider({ getApiKey: async () => 'fake-key', fetchImpl });

    const result = await provider.researchIteration(CAMPAIGN, ITERATION_CONTEXT);

    assert.deepStrictEqual(result.candidates, []);
    assert.strictEqual(result.stopReason, 'json_parse_error');
  });

  await t('researchIteration: erro HTTP da API vira HttpsError "unavailable", nunca uma exceção genérica', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Resource exhausted' } }) });
    const provider = createGeminiProvider({ getApiKey: async () => 'fake-key', fetchImpl });

    await assert.rejects(
      () => provider.researchIteration(CAMPAIGN, ITERATION_CONTEXT),
      (err) => {
        assert.strictEqual(err.code, 'unavailable');
        assert.match(err.message, /Resource exhausted/);
        return true;
      }
    );
  });

  await t('researchIteration: getApiKey nunca é chamado em log/erro (só usado pra montar a URL)', async () => {
    let apiKeyReads = 0;
    const { fetchImpl } = makeFetch([
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: {} },
      { candidates: [{ content: { parts: [{ text: '{"candidates":[]}' }] }, finishReason: 'STOP' }], usageMetadata: {} },
    ]);
    const provider = createGeminiProvider({ getApiKey: async () => { apiKeyReads += 1; return 'fake-key-value'; }, fetchImpl });
    await provider.researchIteration(CAMPAIGN, ITERATION_CONTEXT);
    assert.strictEqual(apiKeyReads, 1, 'getApiKey deveria ser lido uma vez por iteração, nunca cacheado em módulo');
  });
};
