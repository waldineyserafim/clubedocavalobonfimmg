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
    // Fase 3.11 (White Label) — contato institucional é conteúdo público por
    // natureza (aparece hoje hardcoded no rodapé/home de cada organização),
    // não dado sensível como observações/billingConfig/integrations (ver
    // teste "CRÍTICO" acima, que continua garantindo que ESSES nunca entram
    // aqui). Sem eles, index.html/board.html/sobre.html (páginas públicas,
    // sem login) não têm como saber o contato de organização nenhuma além da
    // que está hardcoded no HTML.
    telefone: o.telefone || '',
    email: o.email || '',
    site: o.site || '',
    endereco: o.endereco || '',
    // isSandbox (Fase 3.7) precisa ser público: páginas públicas (index/board/
    // gallery/sobre) usam pra esconder conteúdo institucional hardcoded que
    // pertence só ao CCBMG hoje (fotos reais de diretoria, histórico) — nunca
    // apropriado pra um tenant de demonstração. Não é dado sensível, é
    // exatamente o mesmo booleano que já rege a Central de Configuração.
    isSandbox: o.isSandbox === true,
    updatedAt: serverTimestamp(),
  };
}

module.exports = { computePublicBrandingProjection };
