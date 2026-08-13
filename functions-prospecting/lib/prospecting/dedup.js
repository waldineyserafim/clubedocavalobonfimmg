// functions/lib/prospecting/dedup.js — deduplicação de candidatos encontrados
// pelo agente de Prospecção IA contra leads já existentes (qualquer origem,
// não só prospecção — um lead cadastrado manualmente pro mesmo clube nunca
// deve ganhar um duplicado automático).
//
// Estratégia: normaliza domínio/telefone/nome do candidato em chaves estáveis
// e mantém um índice auxiliar (leadDedupIndex/{chave} -> leadId) — evita
// varrer toda a coleção `leads` a cada candidato (ver CLAUDE.md, "Custo").
// Funções de normalização são puras (testáveis sem Firestore); só
// checkDuplicate/registerDedupKeys tocam o banco, injetado via DI (mesmo
// padrão de lib/leads.js, lib/features.js).

/** Remove protocolo/www/path/query de uma URL e devolve o domínio em minúsculas, ou null se não der pra extrair. */
function normalizeDomain(urlOrDomain) {
  const raw = String(urlOrDomain || '').trim();
  if (!raw) return null;
  let host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  host = host.split('/')[0].split('?')[0].split(':')[0].toLowerCase().trim();
  if (!host || !host.includes('.')) return null;
  return host;
}

/** Mesma lógica de formatPhoneForAsaas (index.js) — remove prefixo 55 se vier com código do país. Devolve só dígitos, ou null se vazio/curto demais pra ser telefone. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits || digits.length < 8) return null;
  if (digits.length === 13 && digits.startsWith('55')) return digits.slice(2);
  if (digits.length === 12 && digits.startsWith('55')) return digits.slice(2);
  return digits;
}

/** Nome normalizado pra comparação: minúsculas, sem acento, sem pontuação, espaços colapsados. */
function normalizeName(raw) {
  const name = String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos (marcas diacríticas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length >= 3 ? name : null;
}

/**
 * @param {object} candidate — { organizacaoNome, website, contatoWhatsapp, contatoEmail }
 * @returns {string[]} chaves de dedup (doc IDs de leadDedupIndex), sem duplicatas, nunca vazias por padrão de campo faltante
 */
function buildDedupKeys(candidate = {}) {
  const keys = new Set();
  const domain = normalizeDomain(candidate.website);
  if (domain) keys.add(`dominio:${domain}`);
  const phone = normalizePhone(candidate.contatoWhatsapp);
  if (phone) keys.add(`telefone:${phone}`);
  const email = String(candidate.contatoEmail || '').trim().toLowerCase();
  if (email && email.includes('@')) keys.add(`email:${email}`);
  const name = normalizeName(candidate.organizacaoNome);
  if (name) keys.add(`nome:${name}`);
  return [...keys];
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {string} [opts.collectionName="leadDedupIndex"]
 */
function createDedupService({ db, collectionName = 'leadDedupIndex' } = {}) {
  if (!db) throw new Error('createDedupService: db é obrigatório.');
  const col = () => db.collection(collectionName);

  /** @returns {Promise<string|null>} leadId do duplicado encontrado, ou null. */
  async function findDuplicateLeadId(keys) {
    if (!keys.length) return null;
    // getAll é 1 round-trip pra até N docs por ID — mais barato que N queries.
    const refs = keys.map((k) => col().doc(k));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) return snap.data().leadId;
    }
    return null;
  }

  /** Registra as chaves de um lead recém-criado no índice — best-effort em lote (não falha a criação do lead se uma chave colidir por corrida rara). */
  async function registerDedupKeys(keys, leadId, { serverTimestamp } = {}) {
    if (!keys.length || !leadId) return;
    const batch = db.batch();
    for (const key of keys) {
      batch.set(col().doc(key), { leadId, createdAt: serverTimestamp ? serverTimestamp() : new Date() });
    }
    await batch.commit();
  }

  return { findDuplicateLeadId, registerDedupKeys };
}

module.exports = {
  createDedupService,
  normalizeDomain,
  normalizePhone,
  normalizeName,
  buildDedupKeys,
};
