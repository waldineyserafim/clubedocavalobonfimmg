// Testa setOrganizationDomains (Fase 3.5) — único escritor de
// domains/{hostname}. Cobre unicidade entre organizações (o requisito real
// do escopo — "garantir que não existam conflitos"), o gate de permissão,
// espelhamento em organizations/{orgId}.dominio, e remoção de domínios
// alternativos que saíram da lista num salvamento seguinte.
const assert = require('assert');
const { seedPlatformAdmin, seedOrganization } = require('./helpers/seed');
const { assertRejectsWithCode } = require('./helpers/assert-code');

module.exports = async function run({ db, authInstance, fns, t }) {
  await seedPlatformAdmin(db, authInstance, { uid: 'dom_administrator', email: 'dom_administrator@teste.local', role: 'administrator' });
  await seedPlatformAdmin(db, authInstance, { uid: 'dom_operator', email: 'dom_operator@teste.local', role: 'operator' });
  await seedOrganization(db, { id: 'dom_org_a', nome: 'Organização A' });
  await seedOrganization(db, { id: 'dom_org_b', nome: 'Organização B' });

  const ctx = (uid) => ({ auth: uid ? { uid } : null });

  await t('setOrganizationDomains: operator não tem acesso', async () => {
    await assertRejectsWithCode(
      () => fns.setOrganizationDomains.run(
        { orgId: 'dom_org_a', dominioPrincipal: 'clubea.com.br' }, ctx('dom_operator')
      ),
      'permission-denied'
    );
  });

  await t('setOrganizationDomains: orgId inexistente é rejeitado', async () => {
    await assertRejectsWithCode(
      () => fns.setOrganizationDomains.run(
        { orgId: 'dom_org_nao_existe', dominioPrincipal: 'x.com.br' }, ctx('dom_administrator')
      ),
      'not-found'
    );
  });

  await t('setOrganizationDomains: domínio principal em formato inválido é rejeitado', async () => {
    await assertRejectsWithCode(
      () => fns.setOrganizationDomains.run(
        { orgId: 'dom_org_a', dominioPrincipal: 'nao é um dominio' }, ctx('dom_administrator')
      ),
      'invalid-argument'
    );
  });

  await t('setOrganizationDomains: caminho feliz — registra principal + alternativo, normaliza e espelha em organizations.dominio', async () => {
    const result = await fns.setOrganizationDomains.run({
      orgId: 'dom_org_a',
      dominioPrincipal: 'HTTPS://Clubea.COM.br/',
      dominiosAlternativos: ['www.clubea.com.br'],
    }, ctx('dom_administrator'));

    assert.strictEqual(result.dominioPrincipal, 'clubea.com.br', 'deveria normalizar protocolo/caixa/barra final');
    assert.deepStrictEqual(result.dominiosAlternativos, ['www.clubea.com.br']);

    const principalDoc = await db.collection('domains').doc('clubea.com.br').get();
    assert.strictEqual(principalDoc.exists, true);
    assert.strictEqual(principalDoc.data().orgId, 'dom_org_a');
    assert.strictEqual(principalDoc.data().tipo, 'primario');
    assert.strictEqual(principalDoc.data().status, 'verificado');

    const altDoc = await db.collection('domains').doc('www.clubea.com.br').get();
    assert.strictEqual(altDoc.exists, true);
    assert.strictEqual(altDoc.data().tipo, 'alternativo');

    const org = (await db.collection('organizations').doc('dom_org_a').get()).data();
    assert.strictEqual(org.dominio, 'clubea.com.br', 'campo existente deve continuar em sincronia (organizations.html/admin_master_associacoes.html leem dele)');
  });

  await t('CRÍTICO: outra organização não consegue reivindicar um domínio já registrado', async () => {
    await assertRejectsWithCode(
      () => fns.setOrganizationDomains.run(
        { orgId: 'dom_org_b', dominioPrincipal: 'clubea.com.br' }, ctx('dom_administrator')
      ),
      'already-exists'
    );
    const doc = await db.collection('domains').doc('clubea.com.br').get();
    assert.strictEqual(doc.data().orgId, 'dom_org_a', 'domínio não deveria ter mudado de dono');
  });

  await t('setOrganizationDomains: a mesma organização pode resalvar seu próprio domínio (não conflita consigo mesma)', async () => {
    const result = await fns.setOrganizationDomains.run({
      orgId: 'dom_org_a', dominioPrincipal: 'clubea.com.br', dominiosAlternativos: ['www.clubea.com.br'],
    }, ctx('dom_administrator'));
    assert.strictEqual(result.dominioPrincipal, 'clubea.com.br');
  });

  await t('setOrganizationDomains: remove domínio alternativo que saiu da lista num salvamento seguinte', async () => {
    const altDocBefore = await db.collection('domains').doc('www.clubea.com.br').get();
    assert.strictEqual(altDocBefore.exists, true, 'pré-condição: alternativo do teste anterior ainda deveria existir');

    await fns.setOrganizationDomains.run({
      orgId: 'dom_org_a', dominioPrincipal: 'clubea.com.br', dominiosAlternativos: [],
    }, ctx('dom_administrator'));

    const altDocAfter = await db.collection('domains').doc('www.clubea.com.br').get();
    assert.strictEqual(altDocAfter.exists, false, 'domínio alternativo removido da lista deveria ter sido apagado');

    const principalDoc = await db.collection('domains').doc('clubea.com.br').get();
    assert.strictEqual(principalDoc.exists, true, 'domínio principal, que continuou na lista, não deveria ter sido afetado');
  });
};
