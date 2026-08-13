// functions/test/prospecting-scoring.test.js — evaluateCandidate é puro
// (sem I/O), mas roda dentro do runner do emulador (ver run-all.js) pra
// manter tudo num único comando de teste — não toca o Firestore.
const assert = require('assert');
const { evaluateCandidate } = require('../lib/prospecting/scoring');

module.exports = async function run({ t }) {
  const qualification = { scoreMinimo: 70, dadosObrigatorios: ['contatoWhatsapp'], evidenciasObrigatorias: 1 };

  await t('evaluateCandidate: candidato vazio é inválido', async () => {
    const r = evaluateCandidate(null, qualification);
    assert.strictEqual(r.valid, false);
  });

  await t('evaluateCandidate: organizacaoNome ausente é inválido', async () => {
    const r = evaluateCandidate({ score: 90, evidence: [{ url: 'x', informacaoExtraida: 'y' }] }, qualification);
    assert.strictEqual(r.valid, false);
    assert.match(r.reason, /organizacaoNome/);
  });

  await t('evaluateCandidate: score fora de 0-100 é inválido', async () => {
    const base = { organizacaoNome: 'Clube X', evidence: [{ url: 'x', informacaoExtraida: 'y' }], contatoWhatsapp: '319999999' };
    assert.strictEqual(evaluateCandidate({ ...base, score: 150 }, qualification).valid, false);
    assert.strictEqual(evaluateCandidate({ ...base, score: 'alto' }, qualification).valid, false);
    assert.strictEqual(evaluateCandidate({ ...base, score: -1 }, qualification).valid, false);
  });

  await t('evaluateCandidate: evidência insuficiente é inválido, mesmo com score alto', async () => {
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 95, evidence: [], contatoWhatsapp: '319999999' },
      qualification
    );
    assert.strictEqual(r.valid, false);
    assert.match(r.reason, /evidências/);
  });

  await t('evaluateCandidate: evidência sem url ou sem informacaoExtraida não conta', async () => {
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 95, evidence: [{ url: '', informacaoExtraida: 'algo' }], contatoWhatsapp: '319999999' },
      qualification
    );
    assert.strictEqual(r.valid, false);
  });

  await t('evaluateCandidate: dado obrigatório da campanha ausente é inválido', async () => {
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 95, evidence: [{ url: 'x', informacaoExtraida: 'y' }] }, // sem contatoWhatsapp
      qualification
    );
    assert.strictEqual(r.valid, false);
    assert.match(r.reason, /contatoWhatsapp/);
  });

  await t('evaluateCandidate: score >= scoreMinimo qualifica como "quente"', async () => {
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 70, evidence: [{ url: 'x', informacaoExtraida: 'y' }], contatoWhatsapp: '319999999' },
      qualification
    );
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.qualificacao, 'quente');
  });

  await t('evaluateCandidate: score < scoreMinimo NUNCA vira "quente" mesmo que o Claude tenha proposto qualificacao="quente" — o corte é sempre determinístico', async () => {
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 69, qualificacao: 'quente', evidence: [{ url: 'x', informacaoExtraida: 'y' }], contatoWhatsapp: '319999999' },
      qualification
    );
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.qualificacao, 'nao_qualificado');
  });

  await t('evaluateCandidate: scoreMinimo é configurável por campanha (nunca hard-coded)', async () => {
    const laxa = { ...qualification, scoreMinimo: 40 };
    const r = evaluateCandidate(
      { organizacaoNome: 'Clube X', score: 45, evidence: [{ url: 'x', informacaoExtraida: 'y' }], contatoWhatsapp: '319999999' },
      laxa
    );
    assert.strictEqual(r.qualificacao, 'quente');
  });
};
