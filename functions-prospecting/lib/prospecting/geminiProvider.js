// functions/lib/prospecting/geminiProvider.js — implementação alternativa de
// AIProvider para o Agente de Prospecção, usando Gemini 2.5 Flash + Google
// Search Grounding (Gemini Developer API / chave gerada em aistudio.google.com
// — NÃO Vertex AI, que não tem free tier real; ver CLAUDE.md/relatório da
// migração pra decisão). Implementa só `researchIteration`, com a MESMA
// assinatura de entrada/saída que claudeProvider.js já tem — engine.js não
// precisa saber qual provider está por trás (ver CLAUDE.md "AIProvider").
//
// `generateOutboundApproach` NÃO existe aqui de propósito — o Agente de
// Outbound deixou de rodar via Cloud Function neste fluxo (ver
// scripts/outbound-weekly*.js); claudeProvider.js continua existindo e
// implementando as duas funções, preservado como fallback (CLAUDE.md,
// "Não deletar implementação existente").
//
// Duas chamadas por iteração, deliberadamente (não uma só), porque a Gemini
// Developer API não documenta de forma confirmada a combinação de um tool
// nativo (google_search) com saída estruturada forçada (responseSchema) na
// MESMA requisição — em vez de arriscar um comportamento não documentado:
//   1) chamada de pesquisa: tools:[{google_search:{}}], texto livre,
//      groundingMetadata com as fontes usadas;
//   2) chamada de extração: SEM tools, responseMimeType:"application/json" +
//      responseSchema, pedindo pro modelo estruturar o que ele mesmo acabou
//      de pesquisar (texto da chamada 1 vai no histórico) no formato de
//      candidates[] que scoring.js/engine.js já esperam.
// Isso também separa claramente "o que veio de busca real" (chamada 1,
// groundingMetadata) de "como foi estruturado" (chamada 2) — mais fácil de
// auditar.
//
// Endpoint usado: generativelanguage.googleapis.com v1beta generateContent
// (estável, documentado há anos, o que os SDKs oficiais usam) — não o
// "Interactions API" (v1alpha, ainda em alpha) que a Google também anuncia.

const functions = require('firebase-functions');

// "gemini-2.5-flash" (nome pedido originalmente) foi desativado pra chaves
// novas em algum momento entre a publicação do modelo e hoje — confirmado
// por chamada real (HTTP 404, "no longer available to new users"). O alias
// "gemini-flash-latest" é o caminho oficial recomendado pela própria mensagem
// de erro da API pra sempre apontar pro Flash corrente (hoje resolve pra
// gemini-3.6-flash, visível em response.modelVersion) — ver CLAUDE.md "Pivô
// Gemini" pro achado completo.
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';
const MAX_OUTPUT_TOKENS = 8000;

// Preço de tabela pago (Gemini 2.5 Flash), usado só como estimativa de custo
// pra controle de limite (campaign.execution.limiteConsumoUsd) — mesmo em
// free tier (custo real US$0), continuamos contando "como se fosse pago" de
// propósito, pra o limite de consumo continuar sendo um teto de segurança
// significativo em vez de virar 0 sempre (ver CLAUDE.md "Custo — Gemini").
const INPUT_PER_MTOK = 0.30;
const OUTPUT_PER_MTOK = 2.50;
// US$35 por 1.000 prompts com grounding, acima da cota gratuita diária (ver
// CLAUDE.md) — contado por CHAMADA que efetivamente usou o tool de busca,
// não por busca individual (a Gemini não cobra por busca, cobra por prompt).
const GROUNDED_PROMPT_COST = 35 / 1000;

const CANDIDATES_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          organizacaoNome: { type: 'string' },
          segmento: { type: 'string', description: 'Um de: clube, associacao, sindicato, conselho, ong, outro.' },
          cidade: { type: 'string' },
          estado: { type: 'string' },
          website: { type: 'string' },
          contatoNome: { type: 'string' },
          contatoCargo: { type: 'string' },
          contatoWhatsapp: { type: 'string' },
          contatoEmail: { type: 'string' },
          score: { type: 'integer' },
          motivoQualificacao: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                titulo: { type: 'string' },
                tipoFonte: { type: 'string' },
                informacaoExtraida: { type: 'string' },
              },
              required: ['url', 'informacaoExtraida'],
            },
          },
        },
        required: ['organizacaoNome', 'score', 'evidence'],
      },
    },
    buscaResumo: { type: 'string' },
  },
  required: ['candidates'],
};

function buildResearchPrompt(campaign, iterationContext) {
  const icp = campaign.icp || {};
  const research = campaign.research || {};
  const qualification = campaign.qualification || {};

  const lines = [
    'Você é um agente de prospecção comercial B2B. Pesquise a web e encontre organizações que sejam candidatas reais a ' +
      'se tornarem clientes de uma plataforma SaaS de gestão para clubes, associações e entidades associativas (Portal ' +
      'Associativo). Você NÃO está prospectando associados/clientes finais de nenhum clube — está prospectando as ' +
      'PRÓPRIAS ORGANIZAÇÕES que poderiam contratar o software.',
    '',
    '## Perfil de Cliente Ideal (ICP)',
    `Segmentos aceitos: ${(icp.segmento || []).join(', ') || 'qualquer um dos permitidos'}.`,
    icp.localizacao ? `Localização alvo: ${JSON.stringify(icp.localizacao)}.` : '',
    icp.porte ? `Porte alvo: ${icp.porte}.` : '',
    (icp.caracteristicasObrigatorias || []).length ? `Características OBRIGATÓRIAS: ${icp.caracteristicasObrigatorias.join('; ')}.` : '',
    (icp.caracteristicasDesejadas || []).length ? `Características desejadas (somam ao score, não obrigatórias): ${icp.caracteristicasDesejadas.join('; ')}.` : '',
    (icp.caracteristicasExclusao || []).length ? `NUNCA incluir candidatos com: ${icp.caracteristicasExclusao.join('; ')}.` : '',
    (icp.palavrasChave || []).length ? `Palavras-chave de interesse: ${icp.palavrasChave.join(', ')}.` : '',
    (icp.sinaisOportunidade || []).length ? `Sinais de oportunidade a procurar: ${icp.sinaisOportunidade.join('; ')}.` : '',
    icp.perfilDecisor ? `Perfil do decisor a identificar quando possível: ${icp.perfilDecisor}.` : '',
    '',
    '## Pesquisa',
    (research.fontesPermitidas || []).length ? `Priorize estas fontes/tipos de fonte: ${research.fontesPermitidas.join(', ')}.` : '',
    (research.termosBase || []).length ? `Termos de pesquisa sugeridos como ponto de partida: ${research.termosBase.join('; ')}.` : '',
    research.profundidade ? `Profundidade de pesquisa esperada: ${research.profundidade}.` : '',
    (research.criteriosValidacao || []).length ? `Critérios de validação de uma fonte confiável: ${research.criteriosValidacao.join('; ')}.` : '',
    '',
    '## Qualificação',
    'Um candidato só deve ser incluído se houver evidência real e verificável (com URL) — nunca invente ou presuma dados sem fonte.',
    (qualification.criteriosLeadQuente || []).length ? `Critérios de lead quente: ${qualification.criteriosLeadQuente.join('; ')}.` : '',
    `Score mínimo pra considerar um candidato qualificado: ${Number.isFinite(qualification.scoreMinimo) ? qualification.scoreMinimo : 70} (0-100) — mas descreva TODOS os candidatos avaliados, mesmo os que ficarem abaixo; a filtragem final é feita por outro sistema.`,
    '',
    '## Contexto desta execução',
    `Já foram encontrados ${iterationContext.leadsEncontrados} lead(s) qualificado(s) até agora; a meta desta execução é até ${iterationContext.metaLeads}.`,
    iterationContext.buscasAnteriores?.length
      ? `Resumo das iterações de pesquisa anteriores nesta mesma execução (NÃO repita os mesmos ângulos de busca): ${iterationContext.buscasAnteriores.join(' | ')}`
      : 'Esta é a primeira iteração de pesquisa desta execução.',
    '',
    'Pesquise agora usando a busca do Google. Descreva, em texto livre, cada organização candidata encontrada — nome, ' +
      'segmento, localização, site, contato/decisor se encontrado, e a evidência concreta (com URL) que sustenta cada ' +
      'afirmação e o score que você daria (0-100) conforme os critérios acima. Nunca afirme um dado como fato sem uma ' +
      'fonte correspondente.',
  ].filter(Boolean);

  return lines.join('\n');
}

async function callGemini({ apiKey, body, fetchImpl = fetch }) {
  const response = await fetchImpl(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = json?.error?.message || `HTTP ${response.status}`;
    throw new functions.https.HttpsError('unavailable', `Gemini API: ${msg}`);
  }
  return json;
}

function sumUsage(target, usageMetadata) {
  if (!usageMetadata) return target;
  target.inputTokens += usageMetadata.promptTokenCount || 0;
  target.outputTokens += usageMetadata.candidatesTokenCount || 0;
  return target;
}

function estimateCostUsd(usage, groundedPrompts) {
  return (usage.inputTokens / 1e6) * INPUT_PER_MTOK + (usage.outputTokens / 1e6) * OUTPUT_PER_MTOK + groundedPrompts * GROUNDED_PROMPT_COST;
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getApiKey — lazy, lido do Secret Manager por quem chama (nunca cacheado aqui em disco/log)
 * @param {typeof fetch} [opts.fetchImpl]
 */
function createGeminiProvider({ getApiKey, fetchImpl } = {}) {
  if (!getApiKey) throw new Error('createGeminiProvider: getApiKey é obrigatório.');

  /**
   * Executa UMA iteração de pesquisa+qualificação, mesmo contrato de
   * claudeProvider.researchIteration — engine.js não distingue os providers.
   * @param {object} campaign — doc de prospectingCampaigns
   * @param {{leadsEncontrados:number, metaLeads:number, buscasAnteriores:string[]}} iterationContext
   */
  async function researchIteration(campaign, iterationContext) {
    const apiKey = await getApiKey();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let groundedPrompts = 0;
    let searchesPerformed = 0;

    // Chamada 1 — pesquisa com Google Search Grounding, texto livre.
    const researchPrompt = buildResearchPrompt(campaign, iterationContext);
    const researchBody = {
      contents: [{ role: 'user', parts: [{ text: researchPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    const researchResponse = await callGemini({ apiKey, body: researchBody, fetchImpl });
    sumUsage(usage, researchResponse.usageMetadata);
    const candidate0 = researchResponse.candidates?.[0];
    const groundingMetadata = candidate0?.groundingMetadata;
    if (groundingMetadata) {
      groundedPrompts += 1;
      searchesPerformed += (groundingMetadata.webSearchQueries || []).length;
    }
    const researchText = (candidate0?.content?.parts || []).map((p) => p.text || '').join('\n');
    if (!researchText.trim()) {
      // Resposta vazia/bloqueada (safety, recitação, etc.) — nunca lança
      // exceção por causa disso (mesma filosofia de runToolLoop em
      // claudeProvider.js); devolve zero candidatos e deixa o engine seguir.
      return {
        candidates: [], buscaResumo: '',
        usage, costUsd: estimateCostUsd(usage, groundedPrompts), searchesPerformed,
        stopReason: candidate0?.finishReason || 'empty_response',
      };
    }

    // Chamada 2 — extração estruturada do que a chamada 1 encontrou, sem
    // tools (ver comentário no topo do arquivo pro porquê da separação).
    const extractBody = {
      contents: [
        { role: 'user', parts: [{ text: researchPrompt }] },
        { role: 'model', parts: [{ text: researchText }] },
        {
          role: 'user',
          parts: [{
            text: 'Estruture agora, em JSON, TODOS os candidatos que você descreveu acima — um item por organização, ' +
              'com as evidências (URL + informação extraída) que você já apresentou. Não pesquise mais nada, só ' +
              'estruture o que já foi encontrado. Inclua um resumo curto (buscaResumo) dos termos/ângulos usados nesta ' +
              'iteração, pra não repetir a mesma busca numa próxima iteração.',
          }],
        },
      ],
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: CANDIDATES_RESPONSE_SCHEMA,
      },
    };
    const extractResponse = await callGemini({ apiKey, body: extractBody, fetchImpl });
    sumUsage(usage, extractResponse.usageMetadata);

    const extractText = (extractResponse.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let parsed = null;
    try {
      parsed = JSON.parse(extractText);
    } catch {
      // JSON malformado é tratado como "nenhum candidato nesta iteração", não
      // como falha da execução inteira (mesma filosofia de erro tolerante do
      // resto do motor — ver engine.js "candidato malformado nunca derruba").
      return {
        candidates: [], buscaResumo: '',
        usage, costUsd: estimateCostUsd(usage, groundedPrompts), searchesPerformed,
        stopReason: 'json_parse_error',
      };
    }

    return {
      candidates: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
      buscaResumo: typeof parsed?.buscaResumo === 'string' ? parsed.buscaResumo : '',
      usage, costUsd: estimateCostUsd(usage, groundedPrompts), searchesPerformed,
      stopReason: extractResponse.candidates?.[0]?.finishReason,
    };
  }

  return { researchIteration };
}

module.exports = { createGeminiProvider, estimateCostUsd, GEMINI_API_URL };
