// functions/lib/leads.js — Módulo de Leads (Release 2, agenda comercial do
// núcleo da plataforma). Mesma forma de functions/lib/features.js: factory
// com DI, sem I/O direto do Admin SDK fora deste arquivo, sem import de
// firebase-admin (só firebase-functions para HttpsError).
//
// MVP deliberado — não é um CRM completo: sem propostas, sem valores
// financeiros estimados, sem integração com organizations/tenantId (Leads e
// Organizações são módulos 100% independentes nesta fase).
//
// Contrato do lead (leads/{leadId}):
//   organizacaoNome, segmento, cidade, estado
//   contatoNome, contatoCargo, contatoWhatsapp, contatoEmail
//   status: "novo"|"qualificado"|"negociacao"|"cliente"|"perdido" — reflete a
//     evolução da OPORTUNIDADE, não o tipo de contato feito (isso é histórico)
//   origem, responsavelUid (sempre inicializado = ownerUid na criação, nunca
//     vazio — reatribuível depois via updateLead), prioridade
//   dores, necessidades, observacoes (texto livre, sem estrutura)
//   sistemaAtual: "nenhum"|"proprio"|"outro", sistemaAtualNome (só quando "outro")
//   associadosEstimados (opcional)
//   proximaAcao: { tipo, data, descricao, concluida }
//   ownerUid (uid de quem criou, imutável), archived (soft delete),
//   ultimaInteracao (escrito só por addLeadHistory), createdAt, updatedAt
//
// leads/{leadId}/history/{historyId} — append-only, sem edição/exclusão:
//   tipo, data, descricao, createdBy, createdAt

const functions = require('firebase-functions');

const STATUSES = ['novo', 'qualificado', 'negociacao', 'cliente', 'perdido'];
const SEGMENTOS = ['clube', 'associacao', 'sindicato', 'conselho', 'ong', 'outro'];
const ORIGENS = ['indicacao', 'site', 'linkedin', 'evento', 'prospeccao', 'outro'];
const PRIORIDADES = ['baixa', 'media', 'alta'];
const SISTEMA_ATUAL_OPCOES = ['nenhum', 'proprio', 'outro'];
// Enum próprio, deliberadamente diferente de HISTORY_TIPOS — tipo de AÇÃO
// PLANEJADA, não tipo de interação já ocorrida (não tem "demonstração").
const PROXIMA_ACAO_TIPOS = ['ligacao', 'whatsapp', 'reuniao', 'email', 'outro'];
const HISTORY_TIPOS = ['ligacao', 'whatsapp', 'email', 'reuniao', 'demonstracao', 'outro'];

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function assertEnum(value, list, fieldName) {
  if (!list.includes(value)) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} precisa ser um de: ${list.join(', ')}.`);
  }
  return value;
}

/** proximaAcao vem sempre como objeto completo do chamador — nunca merge parcial (evita campo órfão de uma versão antiga do form). */
function normalizeProximaAcao(pa) {
  const out = { tipo: null, data: null, descricao: '', concluida: false };
  if (!pa || typeof pa !== 'object') return out;
  if (pa.tipo != null) out.tipo = assertEnum(pa.tipo, PROXIMA_ACAO_TIPOS, 'proximaAcao.tipo');
  if (pa.data instanceof Date) out.data = pa.data;
  if (typeof pa.descricao === 'string') out.descricao = pa.descricao.trim();
  if (typeof pa.concluida === 'boolean') out.concluida = pa.concluida;
  return out;
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 * @param {string} [opts.collectionName="leads"]
 */
function createLeadsService({ db, serverTimestamp, collectionName = 'leads' } = {}) {
  if (!db) throw new Error('createLeadsService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createLeadsService: serverTimestamp é obrigatório.');
  const col = () => db.collection(collectionName);

  async function createLead(fields = {}, { ownerUid } = {}) {
    if (!ownerUid) throw new functions.https.HttpsError('invalid-argument', 'ownerUid é obrigatório.');
    const organizacaoNome = str(fields.organizacaoNome);
    if (!organizacaoNome) throw new functions.https.HttpsError('invalid-argument', 'organizacaoNome é obrigatório.');

    const segmento = fields.segmento != null ? assertEnum(fields.segmento, SEGMENTOS, 'segmento') : null;
    const origem = fields.origem != null ? assertEnum(fields.origem, ORIGENS, 'origem') : null;
    const prioridade = fields.prioridade != null ? assertEnum(fields.prioridade, PRIORIDADES, 'prioridade') : 'media';
    const sistemaAtual = fields.sistemaAtual != null ? assertEnum(fields.sistemaAtual, SISTEMA_ATUAL_OPCOES, 'sistemaAtual') : 'nenhum';

    const docData = {
      organizacaoNome,
      segmento,
      cidade: str(fields.cidade),
      estado: str(fields.estado),
      contatoNome: str(fields.contatoNome),
      contatoCargo: str(fields.contatoCargo),
      contatoWhatsapp: str(fields.contatoWhatsapp),
      contatoEmail: str(fields.contatoEmail),
      status: 'novo', // toda oportunidade nasce em "Novo" — mudar de estágio é sempre uma ação explícita depois
      origem,
      responsavelUid: ownerUid, // quem cria torna-se automaticamente o responsável inicial — nunca nasce sem responsável
      prioridade,
      dores: str(fields.dores),
      necessidades: str(fields.necessidades),
      observacoes: str(fields.observacoes),
      sistemaAtual,
      sistemaAtualNome: sistemaAtual === 'outro' ? str(fields.sistemaAtualNome) : '',
      associadosEstimados: Number.isFinite(fields.associadosEstimados) ? Math.trunc(fields.associadosEstimados) : null,
      proximaAcao: normalizeProximaAcao(fields.proximaAcao),
      ownerUid,
      archived: false,
      ultimaInteracao: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ref = await col().add(docData);
    return { id: ref.id };
  }

  async function updateLead(id, fields = {}) {
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Lead "${id}" não existe.`);

    const update = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);

    if (has('organizacaoNome')) {
      const v = str(fields.organizacaoNome);
      if (!v) throw new functions.https.HttpsError('invalid-argument', 'organizacaoNome não pode ficar vazio.');
      update.organizacaoNome = v;
    }
    if (has('segmento')) update.segmento = fields.segmento != null ? assertEnum(fields.segmento, SEGMENTOS, 'segmento') : null;
    if (has('cidade')) update.cidade = str(fields.cidade);
    if (has('estado')) update.estado = str(fields.estado);
    if (has('contatoNome')) update.contatoNome = str(fields.contatoNome);
    if (has('contatoCargo')) update.contatoCargo = str(fields.contatoCargo);
    if (has('contatoWhatsapp')) update.contatoWhatsapp = str(fields.contatoWhatsapp);
    if (has('contatoEmail')) update.contatoEmail = str(fields.contatoEmail);
    if (has('status')) update.status = assertEnum(fields.status, STATUSES, 'status');
    if (has('origem')) update.origem = fields.origem != null ? assertEnum(fields.origem, ORIGENS, 'origem') : null;
    if (has('responsavelUid')) {
      const v = str(fields.responsavelUid);
      if (!v) throw new functions.https.HttpsError('invalid-argument', 'responsavelUid não pode ficar vazio — um lead nunca fica sem responsável.');
      update.responsavelUid = v;
    }
    if (has('prioridade')) update.prioridade = assertEnum(fields.prioridade, PRIORIDADES, 'prioridade');
    if (has('dores')) update.dores = str(fields.dores);
    if (has('necessidades')) update.necessidades = str(fields.necessidades);
    if (has('observacoes')) update.observacoes = str(fields.observacoes);
    if (has('sistemaAtual')) {
      const sistemaAtual = assertEnum(fields.sistemaAtual, SISTEMA_ATUAL_OPCOES, 'sistemaAtual');
      update.sistemaAtual = sistemaAtual;
      update.sistemaAtualNome = sistemaAtual === 'outro' ? str(fields.sistemaAtualNome) : '';
    }
    if (has('associadosEstimados')) {
      update.associadosEstimados = Number.isFinite(fields.associadosEstimados) ? Math.trunc(fields.associadosEstimados) : null;
    }
    if (has('proximaAcao')) update.proximaAcao = normalizeProximaAcao(fields.proximaAcao);

    update.updatedAt = serverTimestamp();
    await ref.update(update);
  }

  async function archiveLead(id, archived) {
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id é obrigatório.');
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', `Lead "${id}" não existe.`);
    await ref.update({ archived: !!archived, updatedAt: serverTimestamp() });
  }

  async function addLeadHistory(leadId, { tipo, data, descricao } = {}, { createdBy } = {}) {
    if (!leadId) throw new functions.https.HttpsError('invalid-argument', 'leadId é obrigatório.');
    assertEnum(tipo, HISTORY_TIPOS, 'tipo');
    if (!(data instanceof Date)) throw new functions.https.HttpsError('invalid-argument', 'data é obrigatória.');

    const leadRef = col().doc(leadId);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) throw new functions.https.HttpsError('not-found', `Lead "${leadId}" não existe.`);

    const historyRef = leadRef.collection('history').doc();
    await historyRef.set({
      tipo,
      data,
      descricao: str(descricao),
      createdBy: createdBy || null,
      createdAt: serverTimestamp(),
    });
    // Mesma operação, sem trigger/Cloud Function adicional — ultimaInteracao é
    // a data INFORMADA no registro (pode ser retroativa), não o timestamp do servidor.
    await leadRef.update({ ultimaInteracao: data, updatedAt: serverTimestamp() });
    return { id: historyRef.id };
  }

  return { createLead, updateLead, archiveLead, addLeadHistory };
}

module.exports = {
  createLeadsService,
  STATUSES,
  SEGMENTOS,
  ORIGENS,
  PRIORIDADES,
  SISTEMA_ATUAL_OPCOES,
  PROXIMA_ACAO_TIPOS,
  HISTORY_TIPOS,
};
