// functions/test/sandbox-branding.test.js — White Label (Fase 3.11): confirma
// que a projeção pública de branding (organizations/{orgId}/public/branding)
// isola corretamente identidade visual E contato institucional entre
// organizações — o requisito central desta fase ("nenhum usuário consegue
// identificar que a plataforma foi originalmente criada para outro cliente")
// depende disso estar certo pra QUALQUER par de organizações, não só pro
// tenant Sandbox especificamente (nenhuma exceção hardcoded pro Sandbox).
const assert = require('assert');
const { seedOrganization } = require('./helpers/seed');

module.exports = async function run({ db, fns, t }) {
  // Emulador de testes roda só firestore+auth (sem functions) — o trigger
  // onWrite NUNCA dispara sozinho aqui, precisa ser invocado manualmente
  // contra a function exportada (mesmo padrão de organization-public-sync.test.js).
  const orgAData = {
    nome: 'Organização A', modules: { eventos: true },
    config: { logoUrl: 'https://x/a-logo.png', faviconUrl: 'https://x/a-fav.png', corPrimaria: '#111111', corSecundaria: '#222222' },
    telefone: '5531900000001', email: 'contato@org-a.demo', site: 'https://org-a.demo', endereco: 'Endereço A',
  };
  const orgBData = {
    nome: 'Organização B', modules: { eventos: false },
    config: { logoUrl: 'https://x/b-logo.png', faviconUrl: 'https://x/b-fav.png', corPrimaria: '#333333', corSecundaria: '#444444' },
    telefone: '5531900000002', email: 'contato@org-b.demo', site: 'https://org-b.demo', endereco: 'Endereço B',
  };
  await seedOrganization(db, { id: 'wl_org_a', nome: orgAData.nome, modules: orgAData.modules });
  await db.collection('organizations').doc('wl_org_a').update(orgAData);
  await seedOrganization(db, { id: 'wl_org_b', nome: orgBData.nome, modules: orgBData.modules });
  await db.collection('organizations').doc('wl_org_b').update(orgBData);

  await fns.onOrganizationWritten.run(
    { after: { exists: true, data: () => orgAData } },
    { params: { orgId: 'wl_org_a' } }
  );
  await fns.onOrganizationWritten.run(
    { after: { exists: true, data: () => orgBData } },
    { params: { orgId: 'wl_org_b' } }
  );

  await t('projeção pública: cada organização tem seu próprio contato institucional, sem vazar pra outra', async () => {
    const [snapA, snapB] = await Promise.all([
      db.collection('organizations').doc('wl_org_a').collection('public').doc('branding').get(),
      db.collection('organizations').doc('wl_org_b').collection('public').doc('branding').get(),
    ]);
    const a = snapA.data();
    const b = snapB.data();

    assert.strictEqual(a.email, 'contato@org-a.demo');
    assert.strictEqual(b.email, 'contato@org-b.demo');
    assert.notStrictEqual(a.email, b.email, 'CRÍTICO: e-mail de A vazou pra B ou vice-versa');

    assert.strictEqual(a.telefone, '5531900000001');
    assert.strictEqual(b.telefone, '5531900000002');
    assert.strictEqual(a.logoUrl, 'https://x/a-logo.png');
    assert.strictEqual(b.logoUrl, 'https://x/b-logo.png');
    assert.strictEqual(a.corPrimaria, '#111111');
    assert.strictEqual(b.corPrimaria, '#333333');
  });

  await t('projeção pública: nome/logo/cor da organização nunca é o de outra (sem fallback cruzado)', async () => {
    const snapA = await db.collection('organizations').doc('wl_org_a').collection('public').doc('branding').get();
    const a = snapA.data();
    assert.strictEqual(a.nome, 'Organização A');
    assert.notStrictEqual(a.nome, 'Organização B');
  });

  await t('tenant Sandbox oficial (org_teste_etapa10) não usa nenhum campo hardcoded do CCBMG — sanidade de schema', async () => {
    // Não afirma o CONTEÚDO exato (dado de produção pode evoluir), só a FORMA:
    // a mesma função genérica que atende qualquer organização também atende o
    // Sandbox — nenhuma branch de código específica pra ele (ver
    // functions/lib/organizationPublicSync.js: computePublicBrandingProjection
    // não tem "if orgId === 'org_teste_etapa10'" em lugar nenhum).
    const { computePublicBrandingProjection } = require('../lib/organizationPublicSync');
    const fnSource = computePublicBrandingProjection.toString();
    assert.ok(!fnSource.includes('org_teste_etapa10'), 'CRÍTICO: projeção pública não deve ter exceção hardcoded pro Sandbox');
    assert.ok(!fnSource.includes('org_bonfim'), 'CRÍTICO: projeção pública não deve ter exceção hardcoded pro CCBMG');
  });
};
