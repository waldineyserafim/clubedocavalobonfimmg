// functions/lib/sandboxBranding.js — restauração do branding do tenant
// Sandbox oficial (após Fase 3.7/3.10) depois de uma demonstração comercial.
//
// Escopo deliberadamente estreito: só os 4 campos de
// organizations/{orgId}.config que a aba "Identidade Visual" da Central de
// Configuração (Fase 3.4) administra — logoUrl, faviconUrl, corPrimaria,
// corSecundaria. Nunca toca nome/nomeCurto (aba Geral), módulos, Feature
// Flags, billing, nem nenhum dado funcional (associados/eventos/financeiro/
// classificados/parceiros/assinaturas/Asaas) — isso é o Seed Oficial
// (functions/scripts/seedSandboxTenant.js), não este mecanismo.
//
// orgId NUNCA é usado para escolher o alvo — o alvo é sempre a constante
// SANDBOX_ORG_ID abaixo. Não existe forma de chamar isto para nenhuma outra
// organização, mesmo que o payload tente informar outro orgId.

const functions = require('firebase-functions');

const SANDBOX_ORG_ID = 'org_teste_etapa10';

// Snapshot dos valores de branding gravados pelo provisionamento oficial do
// tenant Sandbox (Fase 3.3/3.7), confirmado contra
// organizations/org_teste_etapa10.config em produção em 2026-08-11 — o
// estado "limpo" que uma demonstração comercial deve poder restaurar depois
// de mexer no tema/logo pra mostrar personalização de marca.
const OFFICIAL_SANDBOX_BRANDING = Object.freeze({
  corPrimaria: '#0F766E',
  corSecundaria: '#115E59',
  logoUrl:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiI+CjxyZWN0IHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiByeD0iNDAiIGZpbGw9IiMwRjc2NkUiLz4KPHRleHQgeD0iNTAlIiB5PSI1NCUiIGZvbnQtc2l6ZT0iMTA4IiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNmZmZmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJjZW50cmFsIj5DQTwvdGV4dD4KPC9zdmc+',
  faviconUrl:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiI+CjxyZWN0IHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiByeD0iNDAiIGZpbGw9IiMwRjc2NkUiLz4KPHRleHQgeD0iNTAlIiB5PSI1NCUiIGZvbnQtc2l6ZT0iMTA4IiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNmZmZmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJjZW50cmFsIj5DQTwvdGV4dD4KPC9zdmc+',
});

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 */
function createSandboxBrandingService({ db, serverTimestamp } = {}) {
  if (!db) throw new Error('createSandboxBrandingService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createSandboxBrandingService: serverTimestamp é obrigatório.');

  /**
   * Restaura organizations/org_teste_etapa10.config.{corPrimaria,
   * corSecundaria,logoUrl,faviconUrl} pros valores oficiais. Não escreve em
   * mais nenhum campo do documento (nome, módulos, billing, etc. ficam como
   * estão) — organizations/{orgId}/public/branding é resincronizada
   * automaticamente pelo trigger onOrganizationWritten já existente
   * (functions/lib/organizationPublicSync.js), sem nenhuma escrita direta
   * aqui.
   *
   * Auditoria de quem chamou fica em systemLogs (writePlatformAuditLog, no
   * callable em functions/index.js) — este módulo não grava "quem" em
   * nenhum campo do documento (não é um dado que o schema de organizations
   * já modela, ver comentário no topo sobre não inventar campos).
   *
   * @param {object} params
   * @param {string} [params.orgId] — se informado, precisa bater com o
   *   tenant Sandbox; NUNCA é usado para escolher o alvo (o alvo é sempre
   *   SANDBOX_ORG_ID) — só existe pra pegar um chamador confuso/errado cedo,
   *   com uma mensagem de erro clara em vez de agir sobre outra organização.
   */
  async function restoreSandboxBranding({ orgId } = {}) {
    if (orgId !== undefined && orgId !== null && orgId !== '' && orgId !== SANDBOX_ORG_ID) {
      throw new functions.https.HttpsError(
        'permission-denied',
        `Esta operação só pode ser executada para o tenant Sandbox oficial (${SANDBOX_ORG_ID}).`
      );
    }

    const orgRef = db.collection('organizations').doc(SANDBOX_ORG_ID);
    const orgSnap = await orgRef.get();
    if (!orgSnap.exists) {
      throw new functions.https.HttpsError('not-found', `organizations/${SANDBOX_ORG_ID} não existe.`);
    }
    const orgData = orgSnap.data() || {};
    if (orgData.isSandbox !== true) {
      // Defesa em profundidade: mesmo com SANDBOX_ORG_ID hardcoded aqui,
      // nunca escreve se a flag oficial (Fase 3.7) não confirmar que isto é
      // mesmo o Sandbox — mesma guarda que seedSandboxTenant.js já usa.
      throw new functions.https.HttpsError(
        'failed-precondition',
        `organizations/${SANDBOX_ORG_ID}.isSandbox !== true — recusando restaurar branding.`
      );
    }

    const config = { ...(orgData.config || {}), ...OFFICIAL_SANDBOX_BRANDING };
    await orgRef.update({ config, updatedAt: serverTimestamp() });

    return {
      success: true,
      orgId: SANDBOX_ORG_ID,
      branding: { ...OFFICIAL_SANDBOX_BRANDING },
    };
  }

  return { restoreSandboxBranding, SANDBOX_ORG_ID, OFFICIAL_SANDBOX_BRANDING };
}

module.exports = { createSandboxBrandingService, SANDBOX_ORG_ID, OFFICIAL_SANDBOX_BRANDING };
