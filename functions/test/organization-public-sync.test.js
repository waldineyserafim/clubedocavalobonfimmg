// Testa a projeção pública de branding (Fase 3.5) — organizations/{orgId}
// ganhou, na Fase 3.4, campos que não podem ser públicos (observações,
// billingConfig, integrations). Este teste prova o contrato mais importante
// dele: o subconjunto espelhado NUNCA inclui esses campos, mesmo quando eles
// existem no documento de origem — é uma negação explícita, não uma
// omissão por acaso do schema de teste.
const assert = require('assert');

module.exports = async function run({ db, fns, t }) {
  const fakeTimestamp = { __fake: 'serverTimestamp' };
  const serverTimestamp = () => fakeTimestamp;

  await t('computePublicBrandingProjection: extrai só o subconjunto seguro', async () => {
    const { computePublicBrandingProjection } = require('../lib/organizationPublicSync');
    const projection = computePublicBrandingProjection({
      nome: 'Org Teste', nomeCurto: 'OT',
      config: { logoUrl: 'https://x/logo.png', faviconUrl: 'https://x/fav.png', corPrimaria: '#111279', corSecundaria: '#0a0c55' },
      modules: { associados: true, eventos: false },
      billingProvider: 'asaas',
      observações: 'cliente atrasado, negociar com cuidado',
      billingConfig: { publicParams: { walletId: 'abc' } },
      integrations: { algumaFutura: { chave: 'segredo' } },
    }, serverTimestamp);

    assert.strictEqual(projection.nome, 'Org Teste');
    assert.strictEqual(projection.nomeCurto, 'OT');
    assert.strictEqual(projection.logoUrl, 'https://x/logo.png');
    assert.strictEqual(projection.faviconUrl, 'https://x/fav.png');
    assert.strictEqual(projection.corPrimaria, '#111279');
    assert.strictEqual(projection.corSecundaria, '#0a0c55');
    assert.deepStrictEqual(projection.modules, { associados: true, eventos: false });
    assert.strictEqual(projection.billingProvider, 'asaas');
    assert.strictEqual(projection.updatedAt, fakeTimestamp);

    const exposedKeys = Object.keys(projection);
    assert.ok(!exposedKeys.includes('observações'), 'CRÍTICO: observações internas nunca podem entrar na projeção pública');
    assert.ok(!exposedKeys.includes('billingConfig'), 'CRÍTICO: billingConfig (mesmo publicParams) nunca deve entrar como está — só campos nomeados explicitamente');
    assert.ok(!exposedKeys.includes('integrations'), 'CRÍTICO: integrations nunca pode entrar na projeção pública');
  });

  await t('computePublicBrandingProjection: documento sem config/modules não quebra, retorna campos vazios', async () => {
    const { computePublicBrandingProjection } = require('../lib/organizationPublicSync');
    const projection = computePublicBrandingProjection({ nome: 'Org Mínima' }, serverTimestamp);
    assert.strictEqual(projection.nome, 'Org Mínima');
    assert.strictEqual(projection.logoUrl, '');
    assert.strictEqual(projection.corPrimaria, '');
    assert.deepStrictEqual(projection.modules, {});
  });

  await t('computePublicBrandingProjection: organização sem documento nenhum não quebra', async () => {
    const { computePublicBrandingProjection } = require('../lib/organizationPublicSync');
    const projection = computePublicBrandingProjection(undefined, serverTimestamp);
    assert.strictEqual(projection.nome, '');
  });

  /* =======================================================================
     Trigger onOrganizationWritten — sincroniza organizations/{orgId}/public/branding
     ======================================================================= */

  await t('onOrganizationWritten: grava a projeção em organizations/{orgId}/public/branding', async () => {
    const orgId = 'pubsync_org_a';
    const change = {
      after: {
        exists: true,
        data: () => ({
          nome: 'Clube Teste', nomeCurto: 'CT',
          config: { logoUrl: 'https://x/logo.png', corPrimaria: '#111279', corSecundaria: '#0a0c55' },
          modules: { eventos: true },
          billingProvider: 'asaas',
          observações: 'nunca deveria aparecer',
        }),
      },
    };
    await fns.onOrganizationWritten.run(change, { params: { orgId } });

    const publicSnap = await db.collection('organizations').doc(orgId).collection('public').doc('branding').get();
    assert.strictEqual(publicSnap.exists, true);
    const data = publicSnap.data();
    assert.strictEqual(data.nome, 'Clube Teste');
    assert.strictEqual(data.logoUrl, 'https://x/logo.png');
    assert.strictEqual(data.corPrimaria, '#111279');
    assert.ok(!('observações' in data), 'CRÍTICO: campo sensível não pode vazar pro documento público real');
  });

  await t('onOrganizationWritten: documento apagado remove a projeção pública correspondente', async () => {
    const orgId = 'pubsync_org_deleted';
    await db.collection('organizations').doc(orgId).collection('public').doc('branding').set({ nome: 'Resíduo' });

    await fns.onOrganizationWritten.run({ after: { exists: false } }, { params: { orgId } });

    const publicSnap = await db.collection('organizations').doc(orgId).collection('public').doc('branding').get();
    assert.strictEqual(publicSnap.exists, false);
  });
};
