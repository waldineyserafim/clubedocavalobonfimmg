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
    // whatsapp (Evolução Multi-Tenant, Fase 4): já existia em
    // organizations/{orgId} desde a Fase 3.4 (aba Comunicação), mas nunca
    // tinha sido incluído nesta projeção — páginas públicas continuavam com
    // o WhatsApp do CCBMG hardcoded no HTML por falta de onde ler o valor
    // real da organização (achado #28 da auditoria de hardcodes). Mesmo
    // raciocínio de telefone/email acima: contato institucional é conteúdo
    // público por natureza, não dado sensível.
    whatsapp: o.whatsapp || '',
    // redesSociais (Fase 4): existe em organizations/{orgId}.portal.redesSociais
    // desde a Fase 3.4 (aba Portal), mas nunca tinha consumidor — index.html/
    // board.html continuavam com o link do Instagram do CCBMG hardcoded
    // (achado #36 da auditoria). Precisa ser público (aparece no rodapé/home
    // sem login).
    redesSociais: {
      facebook: o.portal?.redesSociais?.facebook || '',
      instagram: o.portal?.redesSociais?.instagram || '',
      youtube: o.portal?.redesSociais?.youtube || '',
    },
    // billing.plans (Fase 4): tabela de planos/preços da associação —
    // precisa ser pública porque sobre.html mostra os valores pra visitante
    // anônimo, antes de qualquer login (mesma razão de telefone/email acima).
    // Só o array de planos em si (id/label/cycle/price) — nunca
    // mirimDiscountRatio/lateInterestRate, que não aparecem em nenhuma
    // página pública hoje e não precisam sair daqui.
    billing: { plans: Array.isArray(o.billing?.plans) ? o.billing.plans : [] },
    // business.classifieds (Fase 4): classificados.html é pública e mostra o
    // preço/prazo mínimo do anúncio antes de qualquer login.
    //
    // business.auction (Fase 4): leilao_lote.html (visualização de um lote)
    // TAMBÉM é pública (sem requireAuth — só dar lance exige login, via
    // placeBid) e mostra o texto de comissão/incremento mínimo antes de
    // qualquer login. commissionSistemaPct entra aqui também — não é dado
    // sensível (já era texto público estático "5%+5%" antes desta fase),
    // só o próprio split da organização, nunca de outras.
    business: {
      // membership (Fase 4): pg_associado.html (área logada) usa
      // renewSoonDays/graceOverdueDays pra decidir aviso de renovação e
      // bloqueio por inadimplência — lido da MESMA chamada getOrgBranding()
      // já usada nessa página pro nome da organização, sem round-trip extra.
      // Não é dado sensível (são só dias de política, não valores financeiros).
      membership: {
        renewSoonDays: typeof o.business?.membership?.renewSoonDays === 'number' ? o.business.membership.renewSoonDays : 0,
        graceOverdueDays: typeof o.business?.membership?.graceOverdueDays === 'number' ? o.business.membership.graceOverdueDays : 0,
      },
      classifieds: {
        pricePerDay: typeof o.business?.classifieds?.pricePerDay === 'number' ? o.business.classifieds.pricePerDay : 0,
        minimumDays: typeof o.business?.classifieds?.minimumDays === 'number' ? o.business.classifieds.minimumDays : 0,
      },
      auction: {
        minBidIncrementPct: typeof o.business?.auction?.minBidIncrementPct === 'number' ? o.business.auction.minBidIncrementPct : 0,
        antiSniperExtensionMs: typeof o.business?.auction?.antiSniperExtensionMs === 'number' ? o.business.auction.antiSniperExtensionMs : 0,
        commissionClubePct: typeof o.business?.auction?.commissionClubePct === 'number' ? o.business.auction.commissionClubePct : 0,
        commissionSistemaPct: typeof o.business?.auction?.commissionSistemaPct === 'number' ? o.business.auction.commissionSistemaPct : 0,
      },
    },
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
