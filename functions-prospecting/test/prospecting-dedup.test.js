// functions/test/prospecting-dedup.test.js — normalização (pura) e índice de
// deduplicação (createDedupService, contra o emulador). Mesmo padrão de
// pricing.test.js: mistura asserts puros com um trecho contra o Firestore.
const assert = require('assert');
const { normalizeDomain, normalizePhone, normalizeName, buildDedupKeys, createDedupService } = require('../lib/prospecting/dedup');

module.exports = async function run({ db, t }) {
  /* =======================================================================
     Normalização — funções puras
     ======================================================================= */

  await t('normalizeDomain: remove protocolo/www/path/query', async () => {
    assert.strictEqual(normalizeDomain('https://www.Exemplo.COM.br/pagina?x=1'), 'exemplo.com.br');
    assert.strictEqual(normalizeDomain('exemplo.com.br'), 'exemplo.com.br');
    assert.strictEqual(normalizeDomain(''), null);
    assert.strictEqual(normalizeDomain('não é um domínio'), null);
  });

  await t('normalizePhone: remove prefixo 55 e formatação, mesma lógica de formatPhoneForAsaas', async () => {
    assert.strictEqual(normalizePhone('+55 (31) 99999-9999'), '31999999999');
    assert.strictEqual(normalizePhone('31999999999'), '31999999999');
    assert.strictEqual(normalizePhone('123'), null);
    assert.strictEqual(normalizePhone(''), null);
  });

  await t('normalizeName: remove acento/pontuação/espaço duplicado', async () => {
    assert.strictEqual(normalizeName('Associação Nações Únidas  -  MG!!'), 'associacao nacoes unidas mg');
    assert.strictEqual(normalizeName('ab'), null); // curto demais
  });

  await t('buildDedupKeys: gera só as chaves dos campos presentes, sem duplicar', async () => {
    const keys = buildDedupKeys({
      organizacaoNome: 'Clube Xyz', website: 'clubexyz.com.br',
      contatoWhatsapp: '31988887777', contatoEmail: 'Contato@ClubeXyz.com.br',
    });
    assert.deepStrictEqual(keys.sort(), [
      'dominio:clubexyz.com.br', 'email:contato@clubexyz.com.br', 'nome:clube xyz', 'telefone:31988887777',
    ].sort());
    assert.deepStrictEqual(buildDedupKeys({ organizacaoNome: 'X Y Z Clube' }), ['nome:x y z clube']);
  });

  /* =======================================================================
     createDedupService — contra o emulador
     ======================================================================= */

  const dedupService = createDedupService({ db });

  await t('findDuplicateLeadId: sem chaves cadastradas, devolve null', async () => {
    const result = await dedupService.findDuplicateLeadId(['dominio:naoexiste.com.br']);
    assert.strictEqual(result, null);
  });

  await t('registerDedupKeys + findDuplicateLeadId: encontra por QUALQUER uma das chaves', async () => {
    const keys = ['dominio:testeded.com.br', 'telefone:31900000000', 'nome:clube teste dedup'];
    await dedupService.registerDedupKeys(keys, 'lead_dedup_1', { serverTimestamp: () => new Date() });

    assert.strictEqual(await dedupService.findDuplicateLeadId(['dominio:testeded.com.br']), 'lead_dedup_1');
    assert.strictEqual(await dedupService.findDuplicateLeadId(['telefone:31900000000']), 'lead_dedup_1');
    // Candidato novo que só compartilha UMA das 3 chaves ainda é achado como duplicado.
    assert.strictEqual(
      await dedupService.findDuplicateLeadId(['dominio:outrodominio.com.br', 'telefone:31900000000']),
      'lead_dedup_1'
    );
    assert.strictEqual(await dedupService.findDuplicateLeadId(['dominio:completamentediferente.com.br']), null);
  });

  // Limpeza
  await db.collection('leadDedupIndex').doc('dominio:testeded.com.br').delete();
  await db.collection('leadDedupIndex').doc('telefone:31900000000').delete();
  await db.collection('leadDedupIndex').doc('nome:clube teste dedup').delete();
};
