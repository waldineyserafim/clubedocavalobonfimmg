// functions/lib/outbound/salesContext.js — configuração central da proposta
// comercial da Serafim Technologies, usada pelo Agente de Outbound pra saber
// o que está vendendo sem hard-code no prompt do modelo (ver CLAUDE.md
// "Agente de Outbound" — "a Serafim deve poder alterar a proposta comercial
// sem precisar modificar código").
//
// Reaproveita a coleção `systemConfig` já existente e já protegida em
// firestore.rules (read: isPlatformStaff(), write: isPlatformAdministrator())
// — auditada antes de criar qualquer coisa nova: a coleção existia, com
// Rules prontas, sem nenhum leitor/escritor real ainda. Um único documento
// fixo (`systemConfig/salesContext`), sem necessidade de CRUD multi-doc.
//
// Contrato (systemConfig/salesContext):
//   empresa, produto, descricao, propostaValor (strings)
//   diferenciais[], problemasResolvidos[], beneficios[], modulosRelevantes[],
//     restricoesLinguagem[] (arrays de string)
//   publicoAlvo, tom, cta (strings)
//   updatedAt, updatedBy

const DOC_ID = 'salesContext';

const DEFAULTS = {
  empresa: 'Serafim Technologies',
  produto: 'Portal Associativo',
  descricao: '',
  propostaValor: '',
  diferenciais: [],
  publicoAlvo: '',
  problemasResolvidos: [],
  beneficios: [],
  modulosRelevantes: [],
  tom: 'profissional, humano, direto, consultivo, cordial, sem excesso de formalidade',
  cta: '',
  restricoesLinguagem: ['somos líderes', 'solução revolucionária', 'a melhor plataforma do mercado'],
};

function strArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function sanitize(fields = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  const out = {};
  if (has('empresa')) out.empresa = String(fields.empresa || '').trim();
  if (has('produto')) out.produto = String(fields.produto || '').trim();
  if (has('descricao')) out.descricao = String(fields.descricao || '').trim();
  if (has('propostaValor')) out.propostaValor = String(fields.propostaValor || '').trim();
  if (has('diferenciais')) out.diferenciais = strArray(fields.diferenciais);
  if (has('publicoAlvo')) out.publicoAlvo = String(fields.publicoAlvo || '').trim();
  if (has('problemasResolvidos')) out.problemasResolvidos = strArray(fields.problemasResolvidos);
  if (has('beneficios')) out.beneficios = strArray(fields.beneficios);
  if (has('modulosRelevantes')) out.modulosRelevantes = strArray(fields.modulosRelevantes);
  if (has('tom')) out.tom = String(fields.tom || '').trim();
  if (has('cta')) out.cta = String(fields.cta || '').trim();
  if (has('restricoesLinguagem')) out.restricoesLinguagem = strArray(fields.restricoesLinguagem);
  return out;
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {string} [opts.collectionName="systemConfig"]
 */
function createSalesContextService({ db, serverTimestamp, collectionName = 'systemConfig' } = {}) {
  if (!db) throw new Error('createSalesContextService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createSalesContextService: serverTimestamp é obrigatório.');
  const ref = () => db.collection(collectionName).doc(DOC_ID);

  /** Sempre devolve um objeto completo (defaults preenchendo o que não foi configurado ainda) — nunca null, pro Agente de Outbound nunca precisar de guard extra. */
  async function getSalesContext() {
    const snap = await ref().get();
    return { ...DEFAULTS, ...(snap.exists ? snap.data() : {}) };
  }

  async function updateSalesContext(fields = {}, { updatedBy } = {}) {
    const update = sanitize(fields);
    update.updatedAt = serverTimestamp();
    update.updatedBy = updatedBy || null;
    await ref().set(update, { merge: true });
    return getSalesContext();
  }

  return { getSalesContext, updateSalesContext };
}

module.exports = { createSalesContextService, DEFAULTS };
