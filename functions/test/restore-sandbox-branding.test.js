// Testa restoreSandboxBranding — ação exclusiva do Painel Master pro tenant
// Sandbox oficial: restaura só organizations/{orgId}.config.{corPrimaria,
// corSecundaria,logoUrl,faviconUrl} pros valores oficiais, sem tocar em mais
// nada do documento (nome, módulos, billing) e sem existir forma de mirar
// outra organização.
const assert = require('assert');
const { seedPlatformAdmin, seedOrganization } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');
const { SANDBOX_ORG_ID, OFFICIAL_SANDBOX_BRANDING } = require('../lib/sandboxBranding');

module.exports = async function run({ db, authInstance, fns, t }) {
  await seedPlatformAdmin(db, authInstance, { uid: 'sb_administrator', email: 'sb_administrator@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'sb_operator', email: 'sb_operator@teste.local', role: 'operator' });

  await seedOrganization(db, { id: SANDBOX_ORG_ID, nome: 'Clube dos Associados', nomeCurto: 'Clube dos Associados' });
  await db.collection('organizations').doc(SANDBOX_ORG_ID).update({
    isSandbox: true,
    modules: { eventos: true },
    config: {
      corPrimaria: '#FF0000',
      corSecundaria: '#00FF00',
      logoUrl: 'data:image/svg+xml;base64,ZGVzZmlndXJhZG8=',
      faviconUrl: 'data:image/svg+xml;base64,ZGVzZmlndXJhZG8=',
      idioma: 'pt-BR',
      timezone: 'America/Sao_Paulo',
    },
  });

  await seedOrganization(db, { id: 'sb_org_outra', nome: 'Outra Organização' });
  await db.collection('organizations').doc('sb_org_outra').update({ isSandbox: false });

  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await t('restoreSandboxBranding: sem autenticação é rejeitado', async () => {
    await assertRejectsWithCode(
      () => fns.restoreSandboxBranding.run({}, ctx(null)),
      'unauthenticated'
    );
  });

  await t('restoreSandboxBranding: operator não tem acesso (só administrator/owner)', async () => {
    await assertRejectsWithCode(
      () => fns.restoreSandboxBranding.run({}, ctx('sb_operator')),
      'permission-denied'
    );
  });

  await t('CRÍTICO: orgId de outra organização é rejeitado, nunca age sobre ela', async () => {
    await assertRejectsWithCode(
      () => fns.restoreSandboxBranding.run({ orgId: 'sb_org_outra' }, ctx('sb_administrator')),
      'permission-denied'
    );
    const outra = (await db.collection('organizations').doc('sb_org_outra').get()).data();
    assert.strictEqual(outra.config, undefined, 'organização não-Sandbox não deveria ganhar campo config nenhum');
  });

  await t('restoreSandboxBranding: caminho feliz — restaura os 4 campos de branding, preserva o resto de config', async () => {
    const result = await fns.restoreSandboxBranding.run({ orgId: SANDBOX_ORG_ID }, ctx('sb_administrator'));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.orgId, SANDBOX_ORG_ID);
    assert.deepStrictEqual(result.branding, OFFICIAL_SANDBOX_BRANDING);

    const org = (await db.collection('organizations').doc(SANDBOX_ORG_ID).get()).data();
    assert.strictEqual(org.config.corPrimaria, OFFICIAL_SANDBOX_BRANDING.corPrimaria);
    assert.strictEqual(org.config.corSecundaria, OFFICIAL_SANDBOX_BRANDING.corSecundaria);
    assert.strictEqual(org.config.logoUrl, OFFICIAL_SANDBOX_BRANDING.logoUrl);
    assert.strictEqual(org.config.faviconUrl, OFFICIAL_SANDBOX_BRANDING.faviconUrl);
    // Campos de config fora de branding (Localização) não foram tocados.
    assert.strictEqual(org.config.idioma, 'pt-BR');
    assert.strictEqual(org.config.timezone, 'America/Sao_Paulo');
    // Nada funcional foi alterado.
    assert.strictEqual(org.nome, 'Clube dos Associados');
    assert.deepStrictEqual(org.modules, { eventos: true });
  });

  await t('restoreSandboxBranding: idempotente — rodar de novo não muda o resultado nem quebra', async () => {
    const result = await fns.restoreSandboxBranding.run({ orgId: SANDBOX_ORG_ID }, ctx('sb_administrator'));
    assert.deepStrictEqual(result.branding, OFFICIAL_SANDBOX_BRANDING);
  });

  await t('restoreSandboxBranding: organização sem isSandbox:true é rejeitada mesmo com o orgId certo', async () => {
    await db.collection('organizations').doc(SANDBOX_ORG_ID).update({ isSandbox: false });
    await assertRejectsWithCode(
      () => fns.restoreSandboxBranding.run({ orgId: SANDBOX_ORG_ID }, ctx('sb_administrator')),
      'failed-precondition'
    );
    await db.collection('organizations').doc(SANDBOX_ORG_ID).update({ isSandbox: true });
  });
};
