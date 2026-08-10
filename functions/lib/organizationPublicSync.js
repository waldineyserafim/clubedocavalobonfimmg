// functions/lib/organizationPublicSync.js — projeção pública e curada de
// organizations/{orgId} (Fase 3.5).
//
// organizations/{orgId} ganhou, na Fase 3.4, campos que não podem ser
// públicos (observações internas do admin de plataforma, billingConfig,
// integrations — ver firestore.rules, allow get exige login+mesma org).
// Branding, porém, precisa aparecer pra visitante anônimo antes de qualquer
// login. Este módulo isola exatamente o subconjunto seguro — mesma lógica
// que decide o que entra na projeção fica aqui, testável sem Firestore, pra
// nunca depender de "lembrar" de manter a lista em sincronia com o trigger.

/**
 * @param {object} orgData — organizations/{orgId}.data() (pode ser undefined)
 * @param {() => any} serverTimestamp
 * @returns {object} subconjunto seguro pra organizations/{orgId}/public/branding
 */
function computePublicBrandingProjection(orgData, serverTimestamp) {
  const o = orgData || {};
  const config = o.config || {};
  return {
    nome: o.nome || '',
    nomeCurto: o.nomeCurto || '',
    logoUrl: config.logoUrl || '',
    faviconUrl: config.faviconUrl || '',
    corPrimaria: config.corPrimaria || '',
    corSecundaria: config.corSecundaria || '',
    modules: o.modules || {},
    billingProvider: o.billingProvider || '',
    updatedAt: serverTimestamp(),
  };
}

module.exports = { computePublicBrandingProjection };
