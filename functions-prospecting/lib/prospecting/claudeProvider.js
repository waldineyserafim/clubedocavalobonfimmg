// functions/lib/prospecting/claudeProvider.js — ÚNICA integração com a
// Claude API do backend (Messages API + tool `web_search` server-side,
// oficialmente suportado pra pesquisa web autônoma — ver CLAUDE.md deste
// repositório). Usada por DOIS agentes que reaproveitam a mesma factory
// `createClaudeProvider` (mesma credencial, mesmo `callAnthropic`/loop de
// tool-use — nunca uma segunda integração, ver CLAUDE.md "Agente de
// Outbound"):
//   - `researchIteration` — Agente de Prospecção/Qualificação (busca +
//     qualifica organizações candidatas a virar tenant, ver engine.js)
//   - `generateOutboundApproach` — Agente de Outbound (gera abordagem
//     comercial personalizada pra um lead já qualificado, ver
//     lib/outbound/engine.js)
//
// Só este arquivo conhece o formato de requisição/resposta da Anthropic; o
// resto de cada motor fala com a abstração `AIProvider`, pra permitir trocar
// de provider no futuro sem tocar nos orquestradores (ver CLAUDE.md
// "AIProvider → ClaudeProvider" — só o Claude é implementado por ora).
//
// Padrão de chamada HTTP: fetch() nativo do Node 22, mesmo estilo de
// lib/billing/asaas.js e da chamada reCAPTCHA Enterprise em index.js — nenhuma
// dependência nova.
//
// Por que uma tool custom de "resposta final" (submit_candidates/
// submit_approach) em vez de output_config.format: dá pro modelo terminar de
// pesquisar (múltiplas chamadas de web_search dentro da mesma requisição,
// loop server-side nativo) e só então declarar o resultado final chamando
// essa tool — mais robusto do que forçar um schema de saída estruturada por
// cima de um turno que também usa tools server-side.

const functions = require('firebase-functions');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 8000;
const MAX_PAUSE_TURN_RESUMES = 3; // loop server-side do web_search já cobre até 10 buscas por requisição; isto só resolve o caso raro de precisar de mais

const SUBMIT_CANDIDATES_TOOL = {
  type: 'custom',
  name: 'submit_candidates',
  description:
    'Registra o resultado final desta iteração de pesquisa: a lista de organizações candidatas encontradas e avaliadas ' +
    'contra o ICP e os critérios de qualificação, cada uma com evidências e uma justificativa de score. Chame esta tool ' +
    'exatamente uma vez, só depois de terminar toda a pesquisa desta iteração — nunca antes de ter evidência suficiente ' +
    'pra cada candidato que for incluir.',
  input_schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        description: 'Organizações candidatas encontradas e avaliadas nesta iteração (pode ser uma lista vazia se nada relevante foi encontrado).',
        items: {
          type: 'object',
          properties: {
            organizacaoNome: { type: 'string', description: 'Nome da organização candidata.' },
            segmento: { type: 'string', description: 'Um de: clube, associacao, sindicato, conselho, ong, outro.' },
            cidade: { type: 'string' },
            estado: { type: 'string', description: 'UF (2 letras).' },
            website: { type: 'string', description: 'Site oficial, se encontrado.' },
            contatoNome: { type: 'string', description: 'Nome do decisor identificado (presidente, diretor, etc.), se encontrado.' },
            contatoCargo: { type: 'string' },
            contatoWhatsapp: { type: 'string', description: 'Telefone/WhatsApp público encontrado, se houver.' },
            contatoEmail: { type: 'string', description: 'E-mail de contato institucional público, se houver.' },
            score: { type: 'integer', description: 'Score de 0 a 100 de aderência ao ICP e sinais de oportunidade, conforme os critérios de qualificação fornecidos.' },
            motivoQualificacao: { type: 'string', description: 'Justificativa objetiva do score — os critérios específicos que este candidato atende ou não.' },
            evidence: {
              type: 'array',
              description: 'Evidências que sustentam a inclusão e o score deste candidato — nunca uma afirmação sem fonte.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  titulo: { type: 'string' },
                  tipoFonte: { type: 'string', description: 'Ex.: site oficial, notícia, rede social, página de evento.' },
                  informacaoExtraida: { type: 'string', description: 'O fato concreto extraído desta fonte que embasa o score.' },
                },
                required: ['url', 'informacaoExtraida'],
              },
            },
          },
          required: ['organizacaoNome', 'score', 'evidence'],
        },
      },
      buscaResumo: {
        type: 'string',
        description: 'Resumo curto do que foi pesquisado nesta iteração (termos/ângulos usados) — usado para orientar a próxima iteração a não repetir a mesma busca.',
      },
    },
    required: ['candidates'],
  },
};

const SUBMIT_APPROACH_TOOL = {
  type: 'custom',
  name: 'submit_approach',
  description:
    'Registra a abordagem comercial final para este lead — assunto (se aplicável ao canal), mensagem, CTA e a explicação ' +
    'de personalização com evidências. Chame esta tool exatamente uma vez, só depois de ter revisado as informações ' +
    'disponíveis (e feito pesquisa adicional, se necessário e permitido) — nunca antes de ter uma personalização real ' +
    'e verificável para oferecer.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Assunto do e-mail — curto, contextual, nunca clickbait. Vazio ("") se o canal não for e-mail.' },
      message: { type: 'string', description: 'Corpo da abordagem — curto, objetivo, personalizado, com CTA claro. Sem saudação genérica de campanha.' },
      cta: { type: 'string', description: 'A chamada para ação usada na mensagem, isolada (ex.: "Faz sentido conversarmos por 15 minutos?").' },
      personalizationSummary: {
        type: 'string',
        description: 'Resumo de 1-2 frases, para o time comercial, do que foi usado para personalizar esta abordagem.',
      },
      motivos: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista curta de motivos objetivos pelos quais este lead é uma boa oportunidade e a abordagem foi construída assim (ex.: "Segmento compatível", "Evento recente identificado").',
      },
      evidence: {
        type: 'array',
        description: 'Evidências usadas na personalização — cada afirmação específica sobre o lead precisa de uma entrada aqui. Lista vazia se a abordagem usou só informações genéricas do ICP/proposta de valor.',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            titulo: { type: 'string' },
            tipoFonte: { type: 'string', description: 'Ex.: site oficial, notícia, rede social, página de evento, dado já registrado no lead.' },
            informacaoExtraida: { type: 'string', description: 'O fato concreto usado na mensagem.' },
          },
          required: ['informacaoExtraida'],
        },
      },
      researchPerformed: { type: 'boolean', description: 'true se pesquisa web adicional foi realmente usada nesta geração (além dos dados já fornecidos do lead).' },
    },
    required: ['message', 'personalizationSummary', 'evidence'],
  },
};

function buildOutboundSystemPrompt({ lead, salesContext, channel, allowResearch }) {
  const ctx = salesContext || {};
  const ai = lead.aiProspecting || null;

  const lines = [
    'Você é um redator de abordagens comerciais B2B (outbound) para a Serafim Technologies. Sua tarefa é escrever UMA ' +
      'abordagem personalizada para o lead descrito abaixo — não uma mensagem genérica de campanha.',
    '',
    '## O que estamos vendendo (contexto comercial, configurável — nunca hard-code sua própria argumentação por cima disto)',
    ctx.empresa ? `Empresa: ${ctx.empresa}.` : '',
    ctx.produto ? `Produto: ${ctx.produto}.` : '',
    ctx.descricao ? `Descrição: ${ctx.descricao}.` : '',
    ctx.propostaValor ? `Proposta de valor: ${ctx.propostaValor}.` : '',
    (ctx.diferenciais || []).length ? `Diferenciais: ${ctx.diferenciais.join('; ')}.` : '',
    ctx.publicoAlvo ? `Público-alvo: ${ctx.publicoAlvo}.` : '',
    (ctx.problemasResolvidos || []).length ? `Problemas que resolvemos: ${ctx.problemasResolvidos.join('; ')}.` : '',
    (ctx.beneficios || []).length ? `Benefícios: ${ctx.beneficios.join('; ')}.` : '',
    (ctx.modulosRelevantes || []).length ? `Módulos relevantes pra destacar quando fizer sentido: ${ctx.modulosRelevantes.join('; ')}.` : '',
    ctx.tom ? `Tom de comunicação: ${ctx.tom}.` : 'Tom de comunicação: profissional, humano, direto, consultivo, cordial, sem excesso de formalidade.',
    ctx.cta ? `Padrão de CTA preferido (adapte ao contexto, não copie literalmente): ${ctx.cta}.` : '',
    (ctx.restricoesLinguagem || []).length ? `NUNCA use: ${ctx.restricoesLinguagem.join('; ')}.` : '',
    '',
    '## O lead',
    `Organização: ${lead.organizacaoNome}.`,
    lead.segmento ? `Segmento: ${lead.segmento}.` : '',
    (lead.cidade || lead.estado) ? `Localização: ${[lead.cidade, lead.estado].filter(Boolean).join('/')}.` : '',
    lead.contatoNome ? `Contato: ${lead.contatoNome}${lead.contatoCargo ? ` (${lead.contatoCargo})` : ''}.` : 'Nenhum decisor identificado pelo nome — não invente um nome, dirija-se à organização.',
    lead.dores ? `Dores registradas: ${lead.dores}.` : '',
    lead.necessidades ? `Necessidades registradas: ${lead.necessidades}.` : '',
    lead.observacoes ? `Observações: ${lead.observacoes}.` : '',
    ai ? `Este lead foi encontrado e qualificado pelo Agente de Prospecção — score ${ai.score}, classificação "${ai.qualificacao}".` : 'Este lead não passou pelo Agente de Prospecção (provavelmente cadastro manual) — não há score automático.',
    (ai?.evidence || []).length
      ? `Evidências já coletadas na prospecção (USE ESTAS PRIMEIRO, antes de considerar pesquisar mais):\n${ai.evidence.map((e) => `- ${e.informacaoExtraida} (fonte: ${e.url || 'sem URL'})`).join('\n')}`
      : '',
    '',
    `## Canal: ${channel}`,
    channel === 'email' ? 'Gere também um assunto curto e contextual (nunca clickbait, nunca parecer campanha automatizada).' : 'Não gere assunto (deixe subject vazio) — este canal não usa.',
    '',
    '## Regras inegociáveis',
    '- NUNCA afirme algo sobre o lead que não tenha evidência (nas evidências já fornecidas acima, ou encontrada por você agora). Se não houver evidência de um fato, não o mencione como fato.',
    '- NUNCA invente: problemas, clientes, eventos, cargos, faturamento, tecnologias, necessidades ou relacionamentos do lead.',
    '- Mensagem curta e objetiva. Evite textos longos, excesso de adjetivos, "somos líderes", "solução revolucionária", linguagem excessivamente promocional, excesso de emojis.',
    '- CTA simples, sem pressionar o lead.',
    '- A abordagem deve parecer escrita especificamente para este lead, nunca um template genérico com o nome trocado.',
    allowResearch
      ? '- Você PODE pesquisar a web se as informações acima forem insuficientes pra uma personalização real e isso agregar valor significativo — mas não pesquise por pesquisar; se as evidências já fornecidas já bastam, não use as ferramentas de busca.'
      : '- Pesquisa web adicional NÃO está disponível nesta geração — use somente as informações fornecidas acima.',
    '',
    'Quando terminar, chame a tool submit_approach exatamente uma vez com o resultado final.',
  ].filter(Boolean);

  return lines.join('\n');
}

function buildSystemPrompt(campaign, iterationContext) {
  const icp = campaign.icp || {};
  const research = campaign.research || {};
  const qualification = campaign.qualification || {};

  const lines = [
    'Você é um agente de prospecção comercial B2B. Sua tarefa é pesquisar a web e encontrar organizações que sejam ' +
      'candidatas reais a se tornarem clientes de uma plataforma SaaS de gestão para clubes, associações e entidades ' +
      'associativas (Portal Associativo). Você NÃO está prospectando associados/clientes finais de nenhum clube — está ' +
      'prospectando as PRÓPRIAS ORGANIZAÇÕES que poderiam contratar o software.',
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
    `Um candidato só deve ser incluído se houver evidência real e verificável (com URL) — nunca invente ou presuma dados sem fonte.`,
    (qualification.criteriosLeadQuente || []).length ? `Critérios de lead quente: ${qualification.criteriosLeadQuente.join('; ')}.` : '',
    `Score mínimo pra considerar um candidato qualificado: ${Number.isFinite(qualification.scoreMinimo) ? qualification.scoreMinimo : 70} (de 0 a 100) — mas inclua na resposta TODOS os candidatos avaliados nesta iteração, mesmo os que ficaram abaixo do score mínimo; a filtragem final é feita por outro sistema.`,
    '',
    '## Contexto desta execução',
    `Já foram encontrados ${iterationContext.leadsEncontrados} lead(s) qualificado(s) até agora; a meta desta execução é até ${iterationContext.metaLeads}.`,
    iterationContext.buscasAnteriores?.length
      ? `Resumo das iterações de pesquisa anteriores nesta mesma execução (para você NÃO repetir os mesmos ângulos de busca): ${iterationContext.buscasAnteriores.join(' | ')}`
      : 'Esta é a primeira iteração de pesquisa desta execução.',
    '',
    'Pesquise agora usando as ferramentas de busca disponíveis. Quando terminar de avaliar os candidatos desta iteração, ' +
      'chame a tool submit_candidates exatamente uma vez com o resultado final. Nunca afirme um dado como fato sem uma ' +
      'evidência (URL) correspondente em `evidence`.',
  ].filter(Boolean);

  return lines.join('\n');
}

async function callAnthropic({ apiKey, body, fetchImpl = fetch }) {
  const response = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = json?.error?.message || `HTTP ${response.status}`;
    throw new functions.https.HttpsError('unavailable', `Claude API: ${msg}`);
  }
  return json;
}

function sumUsage(target, usage) {
  if (!usage) return target;
  target.inputTokens += usage.input_tokens || 0;
  target.outputTokens += usage.output_tokens || 0;
  target.cacheReadTokens += usage.cache_read_input_tokens || 0;
  target.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
  return target;
}

/** Custo em USD, preço público (sem cache) — só uma estimativa pra controle de limite, não a fatura real. */
function estimateCostUsd(usage) {
  const INPUT_PER_MTOK = 3; // Claude Sonnet 5, preço de tabela (ver shared/model docs)
  const OUTPUT_PER_MTOK = 15;
  return (usage.inputTokens / 1e6) * INPUT_PER_MTOK + (usage.outputTokens / 1e6) * OUTPUT_PER_MTOK;
}

/**
 * Loop de tool-use compartilhado pelos dois agentes: envia a conversa,
 * acumula uso, resolve `pause_turn` (reenvio sem mensagem extra — ver
 * shared/tool-use-concepts.md "Stop reasons for server-side tools"), e para
 * assim que o modelo chamar a tool de resposta final (`finalToolName`).
 * Nunca lança exceção por conta de resposta "ruim" do modelo (sem chamar a
 * tool, refusal, max_tokens truncado) — devolve `toolInput: null` e deixa
 * quem chamou decidir o que fazer (mesma filosofia de step() em
 * provisioning.js: uma chamada ruim não deve derrubar a execução inteira).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.system
 * @param {object[]} opts.tools
 * @param {string} opts.finalToolName
 * @param {string} opts.initialMessage
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.effort]
 */
async function runToolLoop({ apiKey, system, tools, finalToolName, initialMessage, fetchImpl, effort = 'medium' }) {
  let messages = [{ role: 'user', content: initialMessage }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let searchesPerformed = 0;
  let resumes = 0;

  for (;;) {
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      tools,
    };
    const response = await callAnthropic({ apiKey, body, fetchImpl });
    sumUsage(usage, response.usage);
    searchesPerformed += (response.content || []).filter((b) => b.type === 'web_search_tool_result').length;

    const finalBlock = (response.content || []).find((b) => b.type === 'tool_use' && b.name === finalToolName);
    if (finalBlock) {
      return { toolInput: finalBlock.input || {}, usage, costUsd: estimateCostUsd(usage), searchesPerformed, stopReason: response.stop_reason };
    }

    if (response.stop_reason === 'pause_turn' && resumes < MAX_PAUSE_TURN_RESUMES) {
      resumes += 1;
      messages = [...messages, { role: 'assistant', content: response.content }];
      continue;
    }

    return { toolInput: null, usage, costUsd: estimateCostUsd(usage), searchesPerformed, stopReason: response.stop_reason };
  }
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getApiKey — lazy, lido do Secret Manager por quem chama (nunca cacheado aqui em disco/log)
 * @param {typeof fetch} [opts.fetchImpl]
 */
function createClaudeProvider({ getApiKey, fetchImpl } = {}) {
  if (!getApiKey) throw new Error('createClaudeProvider: getApiKey é obrigatório.');

  /**
   * Executa UMA iteração de pesquisa+qualificação. Não decide quando parar —
   * isso é responsabilidade do engine.js (controle de custo/iterações).
   * @param {object} campaign — doc de prospectingCampaigns
   * @param {{leadsEncontrados:number, metaLeads:number, buscasAnteriores:string[]}} iterationContext
   * @returns {Promise<{candidates: object[], buscaResumo: string, usage: {inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens}, costUsd: number, searchesPerformed: number}>}
   */
  async function researchIteration(campaign, iterationContext) {
    const apiKey = await getApiKey();
    const system = buildSystemPrompt(campaign, iterationContext);
    const result = await runToolLoop({
      apiKey, system, fetchImpl,
      initialMessage: 'Inicie a pesquisa desta iteração conforme as instruções do sistema.',
      finalToolName: 'submit_candidates',
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 10 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
        SUBMIT_CANDIDATES_TOOL,
      ],
    });

    const candidates = Array.isArray(result.toolInput?.candidates) ? result.toolInput.candidates : [];
    const buscaResumo = typeof result.toolInput?.buscaResumo === 'string' ? result.toolInput.buscaResumo : '';
    return { candidates, buscaResumo, usage: result.usage, costUsd: result.costUsd, searchesPerformed: result.searchesPerformed, stopReason: result.stopReason };
  }

  /**
   * Gera UMA abordagem comercial personalizada pra um lead já qualificado.
   * Agente de Outbound (ver lib/outbound/engine.js) — nunca decide sozinho
   * se deve regenerar/quantas vezes; isso é responsabilidade de quem chama.
   * @param {object} params
   * @param {object} params.lead — doc de leads/{leadId}
   * @param {object} params.salesContext — systemConfig/salesContext (proposta de valor, tom, CTA, etc.)
   * @param {"email"|"whatsapp"|"linkedin"|"sms"|"outro"} params.channel
   * @param {boolean} [params.allowResearch] — se falso, a tool de pesquisa web nem é oferecida ao modelo (controle de custo)
   * @returns {Promise<{subject:string, message:string, cta:string, personalizationSummary:string, motivos:string[], evidence:object[], researchPerformed:boolean, usage:object, costUsd:number, searchesPerformed:number, stopReason:string|undefined}>}
   */
  async function generateOutboundApproach({ lead, salesContext, channel, allowResearch }) {
    const apiKey = await getApiKey();
    const system = buildOutboundSystemPrompt({ lead, salesContext, channel, allowResearch: !!allowResearch });

    const tools = [SUBMIT_APPROACH_TOOL];
    if (allowResearch) {
      // Custo controlado: max_uses bem mais baixo que o do Agente de
      // Prospecção (10) — o objetivo aqui é uma frase de personalização
      // pontual, nunca uma pesquisa exaustiva (ver CLAUDE.md "Custo").
      tools.unshift(
        { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 }
      );
    }

    const result = await runToolLoop({
      apiKey, system, tools, fetchImpl,
      initialMessage: 'Escreva a abordagem comercial para este lead conforme as instruções do sistema.',
      finalToolName: 'submit_approach',
      effort: 'medium',
    });

    const out = result.toolInput || {};
    return {
      subject: typeof out.subject === 'string' ? out.subject : '',
      message: typeof out.message === 'string' ? out.message : '',
      cta: typeof out.cta === 'string' ? out.cta : '',
      personalizationSummary: typeof out.personalizationSummary === 'string' ? out.personalizationSummary : '',
      motivos: Array.isArray(out.motivos) ? out.motivos : [],
      evidence: Array.isArray(out.evidence) ? out.evidence : [],
      researchPerformed: out.researchPerformed === true,
      usage: result.usage,
      costUsd: result.costUsd,
      searchesPerformed: result.searchesPerformed,
      stopReason: result.stopReason,
    };
  }

  return { researchIteration, generateOutboundApproach };
}

module.exports = { createClaudeProvider, estimateCostUsd, MODEL };
