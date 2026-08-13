// functions/lib/prospecting/scoring.js — validação e qualificação de um
// candidato encontrado pelo agente contra os critérios DA CAMPANHA (nunca
// hard-coded — ver CLAUDE.md "Score"). Módulo puro, sem I/O, 100% testável
// sem emulador: recebe o candidato bruto que o Claude devolveu (via tool
// submit_candidates, ver claudeProvider.js) e o `qualification` da campanha,
// devolve veredito determinístico.
//
// Por que o threshold é aplicado aqui e não confiado ao Claude: o modelo
// propõe score e evidências (ele tem o contexto pra julgar), mas a decisão
// "isso é lead quente ou não" precisa ser auditável e reproduzível — o mesmo
// candidato com o mesmo score sempre cai do mesmo lado do scoreMinimo
// configurado na campanha, nunca varia por causa de uma resposta diferente
// do modelo numa nova chamada.

const QUALIFICACOES = ['quente', 'nao_qualificado'];

/** @returns {boolean} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * @param {object} candidate — como veio do Claude (ver schema de submit_candidates em claudeProvider.js)
 * @param {object} qualification — campaign.qualification: { scoreMinimo, dadosObrigatorios[], evidenciasObrigatorias (número mínimo) }
 * @returns {{valid: boolean, reason: string|null, score: number|null, qualificacao: "quente"|"nao_qualificado"|null}}
 */
function evaluateCandidate(candidate, qualification = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, reason: 'Candidato vazio ou malformado.', score: null, qualificacao: null };
  }
  if (!isNonEmptyString(candidate.organizacaoNome)) {
    return { valid: false, reason: 'organizacaoNome ausente.', score: null, qualificacao: null };
  }

  const score = Number(candidate.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return { valid: false, reason: `score inválido: ${candidate.score}`, score: null, qualificacao: null };
  }

  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const evidenciasValidas = evidence.filter((e) => e && isNonEmptyString(e.url) && isNonEmptyString(e.informacaoExtraida));
  const minEvidencias = Number.isFinite(qualification.evidenciasObrigatorias) ? qualification.evidenciasObrigatorias : 1;
  if (evidenciasValidas.length < minEvidencias) {
    return {
      valid: false,
      reason: `evidências insuficientes: ${evidenciasValidas.length}/${minEvidencias} exigida(s).`,
      score, qualificacao: null,
    };
  }

  const dadosObrigatorios = Array.isArray(qualification.dadosObrigatorios) ? qualification.dadosObrigatorios : [];
  const faltando = dadosObrigatorios.filter((campo) => !isNonEmptyString(candidate[campo]));
  if (faltando.length) {
    return { valid: false, reason: `dado obrigatório ausente: ${faltando.join(', ')}.`, score, qualificacao: null };
  }

  const scoreMinimo = Number.isFinite(qualification.scoreMinimo) ? qualification.scoreMinimo : 70;
  // Nunca reduzir o critério pra "bater a meta" (CLAUDE.md, "IMPORTANTE SOBRE
  // AUTONOMIA DO AGENTE") — o corte é sempre o mesmo, independente de quantos
  // leads a execução já encontrou até aqui.
  const qualificacao = score >= scoreMinimo ? 'quente' : 'nao_qualificado';

  return { valid: true, reason: null, score, qualificacao };
}

module.exports = { evaluateCandidate, QUALIFICACOES };
