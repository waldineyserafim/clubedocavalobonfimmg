// functions/lib/features.js — Feature Flags (Fase 3.8). Camada ÚNICA de
// resolução: nenhuma regra de negócio deve ler featureFlags/{flagKey} direto
// do Firestore — sempre por aqui (server) ou pela callable
// resolveFeatureFlags/lib do cliente (shared/core/tenant/features.js), que
// por sua vez só fala com esta callable, nunca com o Firestore.
//
// Por que a resolução do CLIENTE não pode espelhar modules.js/branding.js
// (getDoc direto + sessionStorage): um doc de flag agrega o mapa `overrides`
// de TODAS as organizações que já tiveram uma exceção configurada. Se o
// client lesse featureFlags/{flagKey} direto, qualquer usuário logado de
// QUALQUER organização enxergaria pra quais outras organizações aquele
// recurso está ligado/desligado — vazamento cross-tenant. A correção é o
// mesmo problema que branding.js resolveu na Fase 3.5 só que na direção
// contrária: lá, o "documento completo" tinha campo demais pra expor;
// aqui, o "documento completo" tem ORGANIZAÇÃO demais pra expor. Solução:
// nenhum documento de flag cru sai do servidor — só o booleano já resolvido
// pra UMA organização, via callable (ver exports.resolveFeatureFlags em
// index.js). O Painel Master (que PRECISA ver o mapa inteiro pra administrar)
// é plataforma, não organização — Firestore Rules dão a ele (isPlatformStaff)
// leitura direta, único papel que enxerga overrides de todo mundo.
//
// Contrato do flag (featureFlags/{flagKey}):
//   key: string (== doc id)
//   description: string
//   category: "module" | "premium" | "experiment" | "beta" | "killswitch" | "other" — informativo/filtro, NUNCA muda a lógica de resolução (uma categoria não é um tipo especial de flag, é só um rótulo pra UI/organização)
//   status: "off" | "on" | "rollout"
//   rolloutPercentage: number (0-100) — só relevante quando status === "rollout"
//   overrides: { [orgId]: boolean } — SEMPRE vence status/rollout; é o mecanismo
//     único que cobre beta interno, cliente piloto (override:true) E
//     desligamento emergencial por tenant (override:false) — não precisa de
//     um "modo" separado pra cada caso de uso da Fase 3.8, "overrides" é
//     genérico o bastante pra todos.
//   environments: string[] | null — restringe a QUALQUER ambiente da lista
//     (compara com organizations/{orgId}.environment da Fase 3.7 — nunca
//     nome de organização); null/ausente = sem restrição de ambiente.
//   archived: boolean — soft-state; nunca hard-delete (mesma filosofia de
//     ativo:false em vez de apagar documento, já usada em toda a base).
//   createdAt, updatedAt, createdBy, updatedBy

const functions = require('firebase-functions');

const STATUSES = ['off', 'on', 'rollout'];
// 20s, curto de propósito (comparar com os 10min de modules.js/branding.js,
// que mudam raríssimo) — MAS leia com atenção o que isto cobre de verdade:
//
// invalidateCache() (chamado por toda mutação abaixo) só limpa o cache DA
// INSTÂNCIA DE PROCESSO que executou a mutação. Cada Cloud Function exportada
// (resolveFeatureFlags, setFeatureFlagStatus, ...) roda em INSTÂNCIAS/
// CONTAINERS SEPARADOS mesmo compartilhando este arquivo — não existe memória
// compartilhada entre elas. Confirmado empiricamente durante o deploy desta
// fase: setFeatureFlagStatus mudando uma flag pra "on" e resolveFeatureFlags
// (outra function, instância quente própria) ainda devolvendo o valor antigo
// alguns segundos depois, mesmo com invalidateCache() rodando do lado de quem
// escreveu. Ou seja: o pior caso real de propagação é este TTL, não "0s
// menos o tempo de invalidação" — CACHE_TTL_MS É o SLA de propagação de um
// kill-switch aqui, não uma otimização cosmética. 20s é o valor escolhido
// como equilíbrio consciente entre esse SLA e custo de leitura do Firestore
// (ver "Sugestões futuras" no relatório da Fase 3.8 pra evoluir isto com
// Firestore onSnapshot — push em vez de poll — se precisar de SLA menor).
const CACHE_TTL_MS = 20 * 1000;

/** Hash determinístico (djb2) — só precisa ser estável e bem distribuído, não criptográfico. */
function stableHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** @returns {boolean} — true se orgId cai no bucket [0,pct) de 100, de forma estável (mesmo org+flag sempre no mesmo bucket). */
function isInRolloutBucket(orgId, flagKey, pct) {
  if (!orgId || !pct) return false;
  const bucket = stableHash(`${flagKey}::${orgId}`) % 100;
  return bucket < pct;
}

/**
 * Função pura de resolução — sem I/O, 100% testável sem Firestore/emulador.
 * @param {object|null} flag — documento de featureFlags/{flagKey} (ou null se não existe/arquivado).
 * @param {{orgId?: string, environment?: string}|null} org — organização de quem está perguntando (null = pergunta "genérica", sem organização — sempre false).
 * @returns {boolean}
 */
function resolveFlag(flag, org) {
  if (!flag || flag.archived) return false; // fail-CLOSED — deliberadamente o oposto do fail-open de modules.js/branding.js: lá, campo ausente = entitlement herdado (agir como sempre agiu); aqui, flag desconhecida = funcionalidade nova/incompleta que nunca foi explicitamente ligada — o padrão seguro é não vazar.
  const orgId = org?.orgId || null;

  if (orgId && flag.overrides && Object.prototype.hasOwnProperty.call(flag.overrides, orgId)) {
    return flag.overrides[orgId] === true;
  }

  if (Array.isArray(flag.environments) && flag.environments.length > 0) {
    const environment = org?.environment || 'production';
    if (!flag.environments.includes(environment)) return false;
  }

  switch (flag.status) {
    case 'on': return true;
    case 'rollout': return isInRolloutBucket(orgId, flag.key || '', Number(flag.rolloutPercentage) || 0);
    case 'off':
    default: return false;
  }
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp — ex.: () => admin.firestore.FieldValue.serverTimestamp() (mesmo padrão de DI de lib/provisioning.js/lib/domains.js — este módulo nunca importa firebase-admin direto, fica testável sem Firestore de verdade).
 * @param {() => any} opts.deleteField — ex.: () => admin.firestore.FieldValue.delete()
 * @param {string} [opts.collectionName="featureFlags"]
 * @param {number} [opts.cacheTtlMs] — cache em memória por instância (processo) — não é por-request; várias
 *   invocações na mesma instância quente reaproveitam. Curto de propósito (ver CACHE_TTL_MS).
 */
function createFeatureService({ db, serverTimestamp, deleteField, collectionName = 'featureFlags', cacheTtlMs = CACHE_TTL_MS } = {}) {
  if (!db) throw new Error('createFeatureService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createFeatureService: serverTimestamp é obrigatório.');
  if (!deleteField) throw new Error('createFeatureService: deleteField é obrigatório.');
  const col = () => db.collection(collectionName);

  let allFlagsCache = null; // { flags: Map<key,doc>, at: number }

  async function loadAllFlags() {
    if (allFlagsCache && Date.now() - allFlagsCache.at < cacheTtlMs) return allFlagsCache.flags;
    const snap = await col().get();
    const flags = new Map();
    snap.forEach((doc) => flags.set(doc.id, { key: doc.id, ...doc.data() }));
    allFlagsCache = { flags, at: Date.now() };
    return flags;
  }

  /** Invalida o cache em memória — chamado por toda mutação (create/setStatus/setOverride/archive) pra nunca servir dado obsoleto na mesma instância. */
  function invalidateCache() {
    allFlagsCache = null;
  }

  async function getFlag(flagKey) {
    const flags = await loadAllFlags();
    return flags.get(flagKey) || null;
  }

  async function getAllFlags() {
    const flags = await loadAllFlags();
    return [...flags.values()];
  }

  /** @returns {Promise<boolean>} */
  async function isEnabled(flagKey, org) {
    const flag = await getFlag(flagKey);
    return resolveFlag(flag, org);
  }

  /** Resolve TODAS as flags pra uma organização de uma vez — usado pela callable resolveFeatureFlags. */
  async function resolveAll(org) {
    const flags = await getAllFlags();
    const result = {};
    for (const flag of flags) {
      if (flag.archived) continue; // flag arquivada nem aparece pro cliente — não é "false", é "não existe mais"
      result[flag.key] = resolveFlag(flag, org);
    }
    return result;
  }

  async function createFlag({ key, description, category = 'other', environments = null, createdBy }) {
    if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new functions.https.HttpsError('invalid-argument', 'key é obrigatória e deve ser snake_case (ex.: "leiloes_v2", "checkout_experimental").');
    }
    const ref = col().doc(key);
    try {
      await ref.create({
        key,
        description: description || '',
        category,
        status: 'off', // toda flag nasce desligada — nunca liga sozinha pra ninguém, ativação é sempre um passo explícito e auditado
        rolloutPercentage: 0,
        overrides: {},
        environments,
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: createdBy || null,
        updatedBy: createdBy || null,
      });
    } catch (e) {
      if (e.code === 6 || e.code === 'already-exists') {
        throw new functions.https.HttpsError('already-exists', `Já existe uma flag "${key}".`);
      }
      throw e;
    }
    invalidateCache();
    return { key };
  }

  async function setStatus(key, status, { rolloutPercentage, updatedBy } = {}) {
    if (!STATUSES.includes(status)) {
      throw new functions.https.HttpsError('invalid-argument', `status precisa ser um de: ${STATUSES.join(', ')}.`);
    }
    const pct = status === 'rollout' ? Number(rolloutPercentage) : 0;
    if (status === 'rollout' && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw new functions.https.HttpsError('invalid-argument', 'rolloutPercentage precisa ser um número entre 0 e 100 quando status="rollout".');
    }
    const ref = col().doc(key);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Flag "${key}" não existe.`);
    await ref.update({
      status,
      rolloutPercentage: pct,
      updatedAt: serverTimestamp(),
      updatedBy: updatedBy || null,
    });
    invalidateCache();
  }

  /** value: true (liga só pra essa org), false (desliga só pra essa org — kill-switch pontual), ou null (remove a exceção, volta a seguir status/rollout). */
  async function setOverride(key, orgId, value, { updatedBy } = {}) {
    if (!orgId) throw new functions.https.HttpsError('invalid-argument', 'orgId é obrigatório.');
    const ref = col().doc(key);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Flag "${key}" não existe.`);
    const fieldPath = `overrides.${orgId}`;
    await ref.update({
      [fieldPath]: value === null ? deleteField() : value === true,
      updatedAt: serverTimestamp(),
      updatedBy: updatedBy || null,
    });
    invalidateCache();
  }

  async function setArchived(key, archived, { updatedBy } = {}) {
    const ref = col().doc(key);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Flag "${key}" não existe.`);
    await ref.update({
      archived: !!archived,
      updatedAt: serverTimestamp(),
      updatedBy: updatedBy || null,
    });
    invalidateCache();
  }

  return {
    isEnabled, resolveAll, getAllFlags, getFlag,
    createFlag, setStatus, setOverride, setArchived,
    invalidateCache,
  };
}

module.exports = { createFeatureService, resolveFlag, isInRolloutBucket, STATUSES };
