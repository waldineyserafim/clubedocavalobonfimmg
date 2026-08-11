#!/usr/bin/env node
// functions/scripts/seedSandboxTenant.js — Seed Oficial do tenant Sandbox (Fase 3.7).
//
// Popula o tenant Sandbox oficial da plataforma (organizations/{orgId} com
// isSandbox === true — nunca resolvido por nome, ver CLAUDE.md "Fase 3.7") com
// dados 100% fictícios: equipe administrativa, associados (normais e mirins),
// eventos, parceiros, classificados e cenários financeiros reais no Asaas
// SANDBOX (nunca produção — a organização já está configurada com
// billingEnvironment: "sandbox" e billingConfig.secretName próprio).
//
// IDEMPOTÊNCIA: cada documento usa um ID determinístico prefixado "sandbox_" e
// carrega seedTag=SEED_TAG. Reexecutar o script nunca duplica — converge cada
// doc pro estado descrito aqui (mesmo espírito de idempotência por passo que
// lib/provisioning.js já usa), preservando createdAt do primeiro run.
//
// AUTENTICAÇÃO: usa o access token do operador já logado via `gcloud auth
// login` (mesmo usado manualmente durante o desenvolvimento desta fase) —
// nenhuma dependência de Application Default Credentials/chave de serviço.
// Requer que a conta tenha papel com permissão de escrita em Firestore, Auth
// (Identity Toolkit) e Secret Manager no projeto (Owner/Editor de plataforma).
//
// GUARDA DE SEGURANÇA: antes de escrever qualquer coisa, confirma
// organizations/{SANDBOX_ORG_ID}.isSandbox === true. Recusa rodar contra
// qualquer outra organização — é o único mecanismo que autoriza a escrita,
// nunca o nome da organização (ver CLAUDE.md).
//
// Uso:
//   node functions/scripts/seedSandboxTenant.js [team|associados|financeFollowup|events|partners|classificados|all]
//   (default: all)
//
// Requer Node 22 (fetch global) — mesma engine de functions/package.json.

const { execSync } = require('child_process');
const { createAsaasBillingProvider } = require('../lib/billing/asaas');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'clubecavalobonfim';
const SANDBOX_ORG_ID = process.env.SANDBOX_ORG_ID || 'org_teste_etapa10';
const SEED_TAG = 'sandbox-seed-v1';
const DEMO_PASSWORD = process.env.SANDBOX_SEED_PASSWORD || 'SandboxDemo#2026';

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const IDENTITY_BASE = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}`;
const SECRET_BASE = `https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}`;

let TOKEN;
function getAccessToken() {
  if (!TOKEN) TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  return TOKEN;
}

async function gfetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': PROJECT_ID,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `HTTP ${res.status} em ${url}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ Firestore REST ============================ */

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[k] = encodeValue(val);
  }
  return fields;
}
function decodeValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

async function firestoreGet(path) {
  try {
    const doc = await gfetch(`${FIRESTORE_BASE}/${path}`);
    return decodeFields(doc.fields);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Overwrite completo (sem updateMask) = convergência idempotente pro estado desejado. */
async function firestoreSet(path, data) {
  await gfetch(`${FIRESTORE_BASE}/${path}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
}

async function firestorePatchFields(path, data) {
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await gfetch(`${FIRESTORE_BASE}/${path}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
}

/**
 * Como upsertDoc, mas nunca faz overwrite total — grava só os campos
 * retornados por buildData (updateMask explícito via firestorePatchFields).
 * Obrigatório para users/{uid}: o documento é co-dono de Cloud Functions
 * (onNewAssociadoCriado grava asaasId/asaasSubscriptionId/asaasSync;
 * onAssociadoAtualizado reage a mudanças de `ativo`) — um PATCH sem máscara
 * apagaria esses campos a cada reexecução do seed (bug encontrado e corrigido
 * durante a Fase 3.7: ver relatório).
 */
async function upsertUserFields(path, buildData) {
  const existing = await firestoreGet(path);
  const data = buildData(existing);
  if (!existing) data.createdAt = new Date();
  await firestorePatchFields(path, data);
  return { created: !existing, data };
}

/** Cria se ausente (createdAt=agora); converge o resto se já existir (preserva createdAt). Só para
 * documentos 100% de propriedade do seed (cms_events/cms_partners/memberClassifieds) — nunca para
 * users/{uid} (ver upsertUserFields). */
async function upsertDoc(path, buildData) {
  const existing = await firestoreGet(path);
  const now = new Date();
  const data = buildData(existing, now);
  delete data.createdAt; // decidido abaixo — nunca reescreve createdAt num doc já existente
  const fields = encodeFields(data);
  fields.createdAt = existing && existing.createdAt ? { timestampValue: existing.createdAt } : encodeValue(now);
  await gfetch(`${FIRESTORE_BASE}/${path}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
  return { created: !existing, data };
}

/* ============================ Identity Toolkit (Auth) ============================ */

async function authLookupByLocalId(localId) {
  try {
    const res = await gfetch(`${IDENTITY_BASE}/accounts:lookup`, {
      method: 'POST',
      body: JSON.stringify({ localId: [localId] }),
    });
    return (res.users && res.users[0]) || null;
  } catch (e) {
    return null;
  }
}

async function ensureAuthUser({ localId, email, password, displayName }) {
  const existing = await authLookupByLocalId(localId);
  if (existing) return { created: false, uid: localId };
  await gfetch(`${IDENTITY_BASE}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ localId, email, password, displayName }),
  });
  return { created: true, uid: localId };
}

/** Converge o e-mail de uma conta Auth já existente pro esperado (idempotente —
 * no-op se já bate). Necessário pra TEAM: uma conta pode ter sido criada antes
 * de ganhar `cpf` (login_master.html → login.html), e ensureAuthUser sozinho
 * nunca atualiza e-mail de conta pré-existente. */
async function ensureAuthUserEmail({ localId, email }) {
  const existing = await authLookupByLocalId(localId);
  if (!existing || existing.email === email) return { updated: false };
  await gfetch(`${IDENTITY_BASE}/accounts:update`, {
    method: 'POST',
    body: JSON.stringify({ localId, email, emailVerified: true }),
  });
  return { updated: true };
}

/* ============================ Secret Manager ============================ */

async function getSecretValue(name) {
  const res = await gfetch(`${SECRET_BASE}/secrets/${name}/versions/latest:access`);
  return Buffer.from(res.payload.data, 'base64').toString('utf8');
}

let _sandboxProvider = null;
async function getSandboxAsaasProvider() {
  if (_sandboxProvider) return _sandboxProvider;
  const apiKey = await getSecretValue('asaas-sandbox-api-key');
  _sandboxProvider = createAsaasBillingProvider({ apiKey, environment: 'sandbox' });
  return _sandboxProvider;
}

/* ============================ Geradores fictícios ============================ */

function seededRandom(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

function cpfCheckDigit(digits) {
  let sum = 0;
  let weight = digits.length + 1;
  for (const d of digits) { sum += d * weight; weight--; }
  const rem = sum % 11;
  return rem < 2 ? 0 : 11 - rem;
}
/** CPF sintético com dígito verificador válido — nunca um CPF real. Determinístico por índice. */
function fakeCpf(index) {
  const rnd = seededRandom(index * 7919 + 13);
  const base = Array.from({ length: 9 }, () => Math.floor(rnd() * 10));
  const d1 = cpfCheckDigit(base);
  const d2 = cpfCheckDigit([...base, d1]);
  return [...base, d1, d2].join('');
}
/** DDD 38 (região de Bonfim/MG) + celular fictício, 11 dígitos. */
function fakePhoneDigits(index) {
  const rnd = seededRandom(index * 104729 + 31);
  const n = Array.from({ length: 8 }, () => Math.floor(rnd() * 10)).join('');
  return `389${n}`;
}
function formatPhoneBR(digits) {
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

const FIRST_NAMES = ['Ana', 'Beatriz', 'Carla', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana', 'Larissa', 'Mariana', 'Natália', 'Otávia', 'Patrícia', 'Camila', 'Rafaela', 'Sabrina', 'Tatiane', 'Vitória', 'André', 'Bruno', 'Carlos', 'Diego', 'Eduardo', 'Felipe', 'Gustavo', 'Henrique', 'Igor', 'João', 'Kleber', 'Lucas', 'Marcelo', 'Nelson', 'Otávio', 'Paulo', 'Rodrigo', 'Sérgio', 'Thiago', 'Vinícius', 'Wagner', 'Yuri', 'Alice', 'Benício', 'Cecília'];
const LAST_NAMES = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Almeida', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Rocha', 'Dias', 'Nascimento', 'Moreira', 'Barbosa', 'Cardoso', 'Teixeira', 'Correia', 'Nunes', 'Machado', 'Araújo', 'Monteiro', 'Pinto', 'Vieira', 'Batista', 'Freitas'];
const STREETS = ['Rua das Tropas', 'Rua do Curral', 'Avenida dos Cavaleiros', 'Rua da Serra', 'Travessa do Pasto', 'Rua Boa Vista', 'Rua das Palmeiras', 'Avenida Bonfim', 'Rua do Rodeio', 'Rua São Sebastião', 'Rua Nossa Senhora Aparecida', 'Rua das Flores'];
const NEIGHBORHOODS = ['Centro', 'São José', 'Bela Vista', 'Alto da Boa Vista', 'Vila Nova', 'Santo Antônio'];

function fakeName(index) {
  const rnd = seededRandom(index * 131 + 7);
  return `${pick(rnd, FIRST_NAMES)} ${pick(rnd, LAST_NAMES)} ${pick(rnd, LAST_NAMES)}`;
}
function fakeAddress(index) {
  const rnd = seededRandom(index * 977 + 3);
  const num = 10 + Math.floor(rnd() * 990);
  return `${pick(rnd, STREETS)}, ${num} - ${pick(rnd, NEIGHBORHOODS)}, Bonfim/MG`;
}
function fakeLogoDataUri(initials, colorHex) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${colorHex}"/><text x="50%" y="50%" font-size="70" fill="#ffffff" font-family="Arial, sans-serif" text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
/** Data local de Brasília, não UTC — evita "data posterior à atual" no Asaas quando UTC já virou o dia seguinte. */
function todayBRDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/* ============================ Guarda de segurança ============================ */

async function assertSandboxOrg() {
  const org = await firestoreGet(`organizations/${SANDBOX_ORG_ID}`);
  if (!org) throw new Error(`organizations/${SANDBOX_ORG_ID} não existe — nada foi escrito.`);
  if (org.isSandbox !== true) {
    throw new Error(
      `organizations/${SANDBOX_ORG_ID}.isSandbox !== true — RECUSANDO escrever. ` +
      `Este seed só roda contra o tenant Sandbox oficial da plataforma (flag isSandbox, nunca o nome). ` +
      `Se esta é mesmo a organização certa, primeiro grave isSandbox:true nela (ver CLAUDE.md "Fase 3.7").`
    );
  }
  return org;
}

/* ============================ Passo: equipe (Master/Admin/Operador) ============================ */

// Único membro da equipe com role "Admin" (Fase 3.12 — antes eram 2, o
// pedido foi reduzir pra 1 só). Perfil (nome/apelido/telefone) copiado do
// perfil real de uma associada do CCBMG a pedido do operador — só os campos
// de identificação pessoal, nunca dados de billing (asaasId/planType/etc,
// que não fazem sentido numa conta administrativa e nunca devem cruzar de
// um associado real de org_bonfim pra uma conta do Sandbox). CPF é sintético
// (nunca o CPF real da pessoa copiada) — login.html funciona por CPF, e
// login_master.html/admin_master.html são mecanismo legado (ver Fase 3.12).
const TEAM = [
  { id: 'sandbox_master_01', role: 'Master', nome: 'Marina Albuquerque' },
  { id: 'sandbox_admin_01', role: 'Admin', nome: 'Mariana Parreiras Marques', apelido: 'Mari', cpf: '11122233043', telefone: '(31) 98267-2712' },
  { id: 'sandbox_operador_01', role: 'Operador', nome: 'Diego Sampaio' },
  { id: 'sandbox_operador_02', role: 'Operador', nome: 'Camila Brant' },
];

async function seedTeam() {
  console.log('\n== Equipe administrativa (Master/Admin/Operador) ==');
  for (const member of TEAM) {
    // Membro com cpf loga pela tela normal de associado (login.html, CPF) —
    // mesma convenção de qualquer associado, e-mail de Auth = {cpf}@cpf.local.
    // Sem cpf, mantém o e-mail fictício @sandbox.invalid (login_master.html,
    // mecanismo legado — só ainda serve pra Master, ver Fase 3.12).
    const email = member.cpf ? `${member.cpf}@cpf.local` : `${member.id}@sandbox.invalid`;
    const auth = await ensureAuthUser({ localId: member.id, email, password: DEMO_PASSWORD, displayName: member.nome });
    if (!auth.created) await ensureAuthUserEmail({ localId: member.id, email });
    await upsertUserFields(`users/${member.id}`, (existing) => ({
      role: member.role,
      nome: member.nome,
      email,
      orgId: SANDBOX_ORG_ID,
      ...(member.apelido ? { apelido: member.apelido } : {}),
      ...(member.cpf ? { cpf: member.cpf } : {}),
      ...(member.telefone ? { telefone: member.telefone } : {}),
      ...(existing ? {} : { ativo: true, primeiroAcesso: true }),
      seedTag: SEED_TAG,
      updatedAt: new Date(),
    }));
    console.log(`  ${member.id} (${member.role}) — auth:${auth.created ? 'criado' : 'já existia'} — login: ${member.cpf ? 'login.html (CPF)' : 'login_master.html'} com ${email}`);
  }
}

/* ============================ Passo: associados + mirins ============================ */

const PLAN_ROTATION = ['mensal', 'trimestral', 'semestral'];

function buildAssociado(i) {
  const cpf = fakeCpf(i);
  const phoneDigits = fakePhoneDigits(i);
  return {
    id: `sandbox_assoc_${String(i).padStart(2, '0')}`,
    cpf,
    nome: fakeName(i),
    telefone: formatPhoneBR(phoneDigits),
    telefoneDigits: phoneDigits,
    endereco: fakeAddress(i),
    planType: PLAN_ROTATION[i % PLAN_ROTATION.length],
  };
}
function buildMirim(i) {
  const respIndex = 200 + i;
  const respCpf = fakeCpf(respIndex);
  const respPhone = fakePhoneDigits(respIndex);
  return {
    id: `sandbox_mirim_${String(i).padStart(2, '0')}`,
    nome: fakeName(300 + i),
    telefone: formatPhoneBR(fakePhoneDigits(300 + i)),
    endereco: fakeAddress(300 + i),
    responsavelNome: fakeName(respIndex),
    responsavelCpf: respCpf,
    responsavelTelefone: formatPhoneBR(respPhone),
    planType: PLAN_ROTATION[i % PLAN_ROTATION.length],
  };
}

// Distribuição de cenários entre os 35 associados normais (índices 1..35):
//   1–15  adimplentes | 16–20 inativos | 21–25 cancelados | 26–30 inadimplentes | 31–35 recém-cadastrados
function scenarioFor(i) {
  if (i <= 15) return 'adimplente';
  if (i <= 20) return 'inativo';
  if (i <= 25) return 'cancelado';
  if (i <= 30) return 'inadimplente';
  return 'recente';
}

async function seedAssociados() {
  console.log('\n== Associados normais (35) ==');
  const created = [];
  for (let i = 1; i <= 35; i++) {
    const a = buildAssociado(i);
    const email = `${a.cpf}@cpf.local`;
    const auth = await ensureAuthUser({ localId: a.id, email, password: DEMO_PASSWORD, displayName: a.nome });
    const scenario = scenarioFor(i);
    const recentlyCreated = scenario === 'recente';
    await upsertUserFields(`users/${a.id}`, (existing) => ({
      cpf: a.cpf,
      apelido: null,
      nome: a.nome,
      telefone: a.telefone,
      endereco: a.endereco,
      role: 'Associado',
      categoriaAssociado: 'normal',
      // ativo é gravado só na criação — depois disso, quem manda nesse campo é
      // seedFinanceFollowup (bucket inativo) ou o próprio admin, nunca este passo.
      ...(existing ? {} : { ativo: true, primeiroAcesso: true }),
      planType: a.planType,
      orgId: SANDBOX_ORG_ID,
      seedTag: SEED_TAG,
      seedScenario: scenario,
      updatedAt: new Date(),
    }));
    console.log(`  ${a.id} [${scenario}] — auth:${auth.created ? 'criado' : 'já existia'} — cpf:${a.cpf}`);
    created.push({ ...a, scenario, recentlyCreated });
  }
  return created;
}

async function seedMirins() {
  console.log('\n== Associados Mirins (5) ==');
  const created = [];
  for (let i = 1; i <= 5; i++) {
    const m = buildMirim(i);
    await upsertUserFields(`users/${m.id}`, (existing) => ({
      categoriaAssociado: 'mirim',
      responsavelNome: m.responsavelNome,
      responsavelCpf: m.responsavelCpf,
      responsavelTelefone: m.responsavelTelefone,
      apelido: null,
      nome: m.nome,
      telefone: m.telefone,
      endereco: m.endereco,
      role: 'Associado',
      ...(existing ? {} : { ativo: true }),
      planType: m.planType,
      orgId: SANDBOX_ORG_ID,
      seedTag: SEED_TAG,
      seedScenario: 'mirim',
      updatedAt: new Date(),
    }));
    console.log(`  ${m.id} — mirim, responsável ${m.responsavelNome}`);
    created.push(m);
  }
  return created;
}

/**
 * Reconciliação — reconstrói asaasId/asaasSubscriptionId/asaasSync quando o doc
 * já tem cliente/assinatura reais no Asaas Sandbox mas o ponteiro no Firestore
 * foi perdido (ex.: bug corrigido nesta fase, onde uma reexecução do seed
 * chegou a sobrescrever o documento inteiro). Idempotente e sem custo quando
 * os campos já existem.
 */
async function repairAsaasLinks(userIds) {
  console.log(`\n== Reconciliando vínculos Asaas Sandbox para ${userIds.length} usuário(s) ==`);
  const provider = await getSandboxAsaasProvider();
  for (const uid of userIds) {
    const doc = await firestoreGet(`users/${uid}`);
    if (!doc) continue;
    if (doc.asaasId && doc.asaasSubscriptionId) continue;
    try {
      const customer = await provider.findCustomerByExternalReference(uid);
      if (!customer) { console.warn(`  ${uid}: nenhum cliente Asaas encontrado — precisa recriar (rode "associados").`); continue; }
      const subs = await provider.listSubscriptionsByCustomer(customer.id, { limit: 1 });
      const subscriptionId = subs[0] ? subs[0].id : null;
      // Nested value num único campo "asaasSync" — não chaves com ponto no payload
      // (updateMask aceita path pontilhado, mas o corpo "fields" precisa refletir a
      // estrutura aninhada de verdade, senão o Firestore cria/zera um campo diferente).
      await firestorePatchFields(`users/${uid}`, {
        asaasId: customer.id,
        asaasSyncedAt: new Date(),
        asaasSubscriptionId: subscriptionId,
        asaasSubscriptionSyncedAt: new Date(),
        asaasSync: { lastSyncedAt: new Date(), lastSyncResult: 'ok', lastSyncError: null },
      });
      console.log(`  ${uid}: reconciliado (asaasId=${customer.id}, subscriptionId=${subscriptionId})`);
    } catch (e) {
      console.warn(`  ${uid}: falha ao reconciliar (ignorado): ${e.message}`);
    }
  }
}

/** Aguarda o trigger onNewAssociadoCriado terminar (asaasSync.lastSyncResult presente) pra cada uid. */
async function waitForAsaasSync(uids, { timeoutMs = 120000, pollMs = 3000 } = {}) {
  console.log(`\n== Aguardando onNewAssociadoCriado sincronizar ${uids.length} associado(s) com o Asaas Sandbox ==`);
  const pending = new Set(uids);
  const start = Date.now();
  while (pending.size && Date.now() - start < timeoutMs) {
    for (const uid of [...pending]) {
      const doc = await firestoreGet(`users/${uid}`);
      const result = doc && doc.asaasSync && doc.asaasSync.lastSyncResult;
      if (result) {
        console.log(`  ${uid}: asaasSync=${result}${result === 'error' ? ' — ' + doc.asaasSync.lastSyncError : ''}`);
        pending.delete(uid);
      }
    }
    if (pending.size) await sleep(pollMs);
  }
  if (pending.size) {
    console.warn(`  Timeout aguardando: ${[...pending].join(', ')} — rode o script novamente depois, é idempotente.`);
  }
}

/* ============================ Passo: pós-processamento financeiro ============================ */

async function financeFollowupInativos(users) {
  const bucket = users.filter((u) => u.scenario === 'inativo');
  console.log(`\n== Desativando ${bucket.length} associado(s) (dispara onAssociadoAtualizado real) ==`);
  for (const u of bucket) {
    await firestorePatchFields(`users/${u.id}`, {
      ativo: false,
      desativadoEm: new Date(),
      desativadoPor: 'seedSandboxTenant',
      notaDesativacao: 'Cenário de demonstração — inativo (Seed Oficial Sandbox).',
      updatedAt: new Date(),
    });
    console.log(`  ${u.id}: ativo=false`);
  }
}

async function financeFollowupCancelados(users) {
  const bucket = users.filter((u) => u.scenario === 'cancelado');
  console.log(`\n== Cancelando assinatura de ${bucket.length} associado(s) (pausa real no Asaas Sandbox) ==`);
  const provider = await getSandboxAsaasProvider();
  for (const u of bucket) {
    const doc = await firestoreGet(`users/${u.id}`);
    if (doc && doc.asaasSubscriptionId) {
      await provider.cancelSubscription(doc.asaasSubscriptionId).catch((e) =>
        console.warn(`  ${u.id}: falha ao pausar assinatura no Asaas (ignorado): ${e.message}`)
      );
    }
    await firestorePatchFields(`users/${u.id}`, {
      assinaturaCanceladaEm: new Date(),
      assinaturaCanceladaPeloAssociado: true,
      updatedAt: new Date(),
    });
    console.log(`  ${u.id}: assinatura pausada + cancelamento registrado (ativo continua true)`);
  }
}

async function financeFollowupInadimplentes(users) {
  const bucket = users.filter((u) => u.scenario === 'inadimplente');
  console.log(`\n== Registrando ${bucket.length} fatura(s) vencida(s) (inadimplência) ==`);
  for (const u of bucket) {
    const due = addDays(new Date(), -20);
    const planEnd = addDays(due, -10);
    const value = { mensal: 30, trimestral: 85, semestral: 170 }[u.planType] || 30;
    await upsertDoc(`users/${u.id}/financeInvoices/sandbox_fatura_${u.id}_01`, () => ({
      planType: u.planType,
      planName: u.planType[0].toUpperCase() + u.planType.slice(1),
      amount: value,
      status: 'atrasado',
      paidAt: null,
      planStart: planEnd,
      planEnd,
      dueDate: due,
      method: null,
      notes: 'Cenário de demonstração — inadimplente (Seed Oficial Sandbox).',
      recordedByUid: 'seedSandboxTenant',
      recordedByName: 'Seed Oficial Sandbox',
      recordedByCPF: null,
      seedTag: SEED_TAG,
      updatedAt: new Date(),
    }));
    await firestoreSet(`users/${u.id}/finance/summary`, {
      lastPayment: null,
      lastAmount: null,
      nextDue: due,
      activeUntil: planEnd,
      exempt: false,
      exemptUntil: null,
      updatedAt: new Date(),
    });
    console.log(`  ${u.id}: fatura vencida em ${due.toISOString().slice(0, 10)}`);
  }
}

async function financeFollowupAdimplentes(users) {
  const bucket = users.filter((u) => u.scenario === 'adimplente');
  console.log(`\n== Confirmando pagamento real no Asaas Sandbox para ${bucket.length} associado(s) adimplente(s) ==`);
  const provider = await getSandboxAsaasProvider();
  for (const u of bucket) {
    const doc = await firestoreGet(`users/${u.id}`);
    if (!doc || !doc.asaasSubscriptionId) {
      console.warn(`  ${u.id}: sem asaasSubscriptionId ainda — pulei (rode o script de novo depois).`);
      continue;
    }
    try {
      const charges = await provider.listCharges({ subscriptionId: doc.asaasSubscriptionId, limit: 1, sort: 'dueDate', order: 'asc' });
      const charge = charges[0];
      if (!charge) { console.warn(`  ${u.id}: nenhuma cobrança encontrada ainda — pulei.`); continue; }
      const value = { mensal: 30, trimestral: 85, semestral: 170 }[u.planType] || 30;
      if (charge.status !== 'pago') {
        await provider.receiveInCash(charge.providerId, { paymentDate: todayBRDateStr(), value: charge.value || value });
      }
      const planStart = new Date();
      const planEnd = { mensal: addDays(planStart, 30), trimestral: addDays(planStart, 90), semestral: addDays(planStart, 180) }[u.planType] || addDays(planStart, 30);
      await upsertDoc(`users/${u.id}/financeInvoices/sandbox_fatura_${u.id}_01`, () => ({
        planType: u.planType,
        planName: u.planType[0].toUpperCase() + u.planType.slice(1),
        amount: charge.value || value,
        status: 'pago',
        paidAt: planStart,
        planStart,
        planEnd,
        dueDate: charge.dueDate || planStart,
        method: 'Dinheiro (simulado — receiveInCash Asaas Sandbox)',
        notes: 'Cenário de demonstração — adimplente (Seed Oficial Sandbox).',
        asaasPaymentId: charge.providerId,
        recordedByUid: 'seedSandboxTenant',
        recordedByName: 'Seed Oficial Sandbox',
        recordedByCPF: null,
        seedTag: SEED_TAG,
        updatedAt: new Date(),
      }));
      await firestoreSet(`users/${u.id}/finance/summary`, {
        lastPayment: planStart,
        lastAmount: charge.value || value,
        nextDue: null,
        activeUntil: addDays(planEnd, 10),
        exempt: false,
        exemptUntil: null,
        updatedAt: new Date(),
      });
      console.log(`  ${u.id}: pago (charge ${charge.providerId}) — activeUntil ${addDays(planEnd, 10).toISOString().slice(0, 10)}`);
    } catch (e) {
      console.warn(`  ${u.id}: falha ao confirmar pagamento (ignorado): ${e.message}`);
    }
  }
}

async function seedFinanceFollowup(users) {
  await financeFollowupInativos(users);
  await financeFollowupCancelados(users);
  await financeFollowupInadimplentes(users);
  await financeFollowupAdimplentes(users);
  console.log('\n  (bucket "recente" não recebe pós-processamento — a assinatura recém-criada com 1ª cobrança em aberto já é o cenário desejado.)');
}

/* ============================ Passo: eventos ============================ */

async function seedEvents(masterUid) {
  console.log('\n== Eventos (cms_events) ==');
  const now = new Date();
  const events = [
    { id: 'sandbox_evt_01', titulo: 'Cavalgada de Primavera', descricao: 'Cavalgada tradicional pelas trilhas ao redor de Bonfim/MG, com apoio da diretoria. Evento fictício de demonstração.', local: 'Sede do Clube dos Associados', hora: '07:00', data: addDays(now, 45), valor: 0, permiteInscricao: true, somenteSocioEmDia: false, eventoDestaque: false, maxInscritos: 150, dataEncerramento: addDays(now, 40) },
    { id: 'sandbox_evt_02', titulo: 'Encontro de Confraternização 2025', descricao: 'Encontro anual de confraternização entre associados. Evento fictício, já encerrado.', local: 'Salão de Festas do Clube', hora: '19:00', data: addDays(now, -60), valor: 0, permiteInscricao: false, somenteSocioEmDia: false, eventoDestaque: false, maxInscritos: 0, dataEncerramento: addDays(now, -65) },
    { id: 'sandbox_evt_03', titulo: 'Prova Funcional Equestre', descricao: 'Prova de adestramento funcional exclusiva para sócios em dia com a mensalidade. Evento fictício de demonstração.', local: 'Pista de Provas', hora: '08:30', data: addDays(now, 20), valor: 0, permiteInscricao: true, somenteSocioEmDia: true, eventoDestaque: false, maxInscritos: 40, dataEncerramento: addDays(now, 15) },
    { id: 'sandbox_evt_04', titulo: 'Feira do Cavalo — Edição Sandbox', descricao: 'Feira aberta ao público com exposição de animais, arreios e produtos equestres. Evento fictício de demonstração.', local: 'Área Externa do Clube', hora: '09:00', data: addDays(now, 10), valor: 0, permiteInscricao: true, somenteSocioEmDia: false, eventoDestaque: true, maxInscritos: 0, dataEncerramento: addDays(now, 9) },
    { id: 'sandbox_evt_05', titulo: 'Jantar Beneficente CDA', descricao: 'Jantar beneficente com renda revertida para manutenção da sede. Evento fictício de demonstração.', local: 'Salão de Festas do Clube', hora: '20:00', data: addDays(now, 30), valor: 150, permiteInscricao: true, somenteSocioEmDia: false, eventoDestaque: false, maxInscritos: 80, dataEncerramento: addDays(now, 27) },
  ];
  for (const e of events) {
    await upsertDoc(`cms_events/${e.id}`, () => ({
      orgId: SANDBOX_ORG_ID,
      titulo: e.titulo,
      descricao: e.descricao,
      local: e.local,
      hora: e.hora,
      data: e.data,
      valor: e.valor,
      linkInscricao: '',
      eventoDestaque: e.eventoDestaque,
      imagem: fakeLogoDataUri('🐴', '#6b4423'),
      ativo: true,
      deleted: false,
      permiteInscricao: e.permiteInscricao,
      somenteSocioEmDia: e.somenteSocioEmDia,
      dataEncerramento: e.dataEncerramento,
      maxInscritos: e.maxInscritos,
      createdBy: masterUid,
      updatedBy: masterUid,
      seedTag: SEED_TAG,
      updatedAt: new Date(),
    }));
    console.log(`  ${e.id}: ${e.titulo}`);
  }
}

/* ============================ Passo: parceiros ============================ */

async function seedPartners(masterUid) {
  console.log('\n== Parceiros (cms_partners) ==');
  const partners = [
    { id: 'sandbox_parceiro_01', nome: 'VetEquus Clínica Veterinária', categoria: 'Veterinária', descricao: 'Atendimento veterinário especializado em equinos, com 15% de desconto para associados. Parceiro fictício de demonstração.', destaque: true, ativo: true, color: '#2e7d32' },
    { id: 'sandbox_parceiro_02', nome: 'Ferraria do Zé', categoria: 'Ferrageamento', descricao: 'Serviço de ferrageamento e casqueamento a domicílio. Parceiro fictício de demonstração.', destaque: false, ativo: true, color: '#5d4037' },
    { id: 'sandbox_parceiro_03', nome: 'Ração Boa Pastagem', categoria: 'Alimentação Equina', descricao: 'Rações e suplementos equinos com condições especiais para sócios. Parceiro fictício de demonstração.', destaque: false, ativo: true, color: '#8d6e63' },
    { id: 'sandbox_parceiro_04', nome: 'TransFreight Cavalos', categoria: 'Transporte', descricao: 'Transporte especializado de equinos entre eventos. Parceiro fictício de demonstração.', destaque: false, ativo: true, color: '#37474f' },
    { id: 'sandbox_parceiro_05', nome: 'Selaria Bonfim', categoria: 'Equipamentos', descricao: 'Selas, arreios e equipamentos equestres sob medida. Parceiro fictício de demonstração.', destaque: true, ativo: true, color: '#6d4c41' },
    { id: 'sandbox_parceiro_06', nome: 'Pousada Vale do Cavalo', categoria: 'Hotelaria/Turismo', descricao: 'Hospedagem com desconto para associados em passeios e cavalgadas. Parceiro fictício de demonstração.', destaque: false, ativo: true, color: '#00695c' },
    { id: 'sandbox_parceiro_07', nome: 'Seguros Trote Seguro', categoria: 'Seguros', descricao: 'Seguros para equinos e equipamentos com condições exclusivas. Parceiro fictício de demonstração.', destaque: false, ativo: true, color: '#1565c0' },
    { id: 'sandbox_parceiro_08', nome: 'Petshop Casco de Ouro', categoria: 'Alimentação Equina', descricao: 'Petshop e casa de ração — parceria encerrada. Parceiro fictício de demonstração.', destaque: false, ativo: false, color: '#757575' },
  ];
  for (const p of partners) {
    await upsertDoc(`cms_partners/${p.id}`, () => ({
      orgId: SANDBOX_ORG_ID,
      nome: p.nome,
      categoria: p.categoria,
      ordem: 10,
      site: '',
      whatsapp: '5538988887777',
      descricao: p.descricao,
      logo: fakeLogoDataUri(p.nome.slice(0, 2).toUpperCase(), p.color),
      destaque: p.destaque,
      ativo: p.ativo,
      deleted: false,
      createdBy: masterUid,
      updatedBy: masterUid,
      seedTag: SEED_TAG,
      updatedAt: new Date(),
    }));
    console.log(`  ${p.id}: ${p.nome} (${p.categoria}, ativo=${p.ativo})`);
  }
}

/* ============================ Passo: classificados ============================ */

async function seedClassificados(associados) {
  console.log('\n== Classificados (memberClassifieds) ==');
  const owners = associados.filter((a) => a.scenario === 'adimplente');
  const items = [
    { id: 'sandbox_classificado_01', title: 'Sela australiana usada, ótimo estado', description: 'Sela australiana em couro legítimo, pouco uso. Item fictício de demonstração.', price: 1800, active: true, approved: true, paymentStatus: 'pago' },
    { id: 'sandbox_classificado_02', title: 'Arreio completo para marcha', description: 'Arreio completo, freio articulado e rédeas. Item fictício de demonstração.', price: 950, active: true, approved: true, paymentStatus: 'pago' },
    { id: 'sandbox_classificado_03', title: 'Manta térmica para cavalo', description: 'Manta térmica impermeável, tamanho M. Item fictício de demonstração.', price: 220, active: true, approved: true, paymentStatus: 'pago' },
    { id: 'sandbox_classificado_04', title: 'Botas de montaria n° 40', description: 'Botas de montaria em couro, semi-novas. Item fictício de demonstração.', price: 380, active: true, approved: true, paymentStatus: 'pago' },
    { id: 'sandbox_classificado_05', title: 'Cabresto de corda trançada', description: 'Cabresto artesanal de corda trançada. Item fictício de demonstração.', price: 65, active: true, approved: false, paymentStatus: 'pendente' },
    { id: 'sandbox_classificado_06', title: 'Carreta 2 baias — bom estado', description: 'Carreta para transporte de 2 equinos, revisada. Item fictício de demonstração.', price: 22000, active: true, approved: false, paymentStatus: 'pendente' },
    { id: 'sandbox_classificado_07', title: 'Fardos de feno tifton', description: 'Fardos de feno tifton de alta qualidade. Item fictício de demonstração.', price: 35, active: false, approved: true, paymentStatus: 'pago', expired: true },
    { id: 'sandbox_classificado_08', title: 'Freio articulado inox', description: 'Freio articulado em inox, pouco uso. Item fictício de demonstração.', price: 180, active: false, approved: true, paymentStatus: 'pago', expired: true },
    { id: 'sandbox_classificado_09', title: 'Balde e comedouro para baia', description: 'Kit balde e comedouro em polietileno reforçado. Item fictício de demonstração.', price: 90, active: true, approved: true, paymentStatus: 'pago' },
    { id: 'sandbox_classificado_10', title: 'Protetor de cauda e crina', description: 'Protetor de cauda e crina, tecido respirável. Item fictício de demonstração.', price: 55, active: false, approved: false, paymentStatus: 'pendente' },
  ];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const owner = owners[idx % owners.length];
    const paymentCreatedAt = it.expired ? addDays(new Date(), -90) : addDays(new Date(), -Math.floor(Math.random() * 10));
    await upsertDoc(`memberClassifieds/${it.id}`, () => ({
      title: it.title,
      description: it.description,
      price: it.price,
      whatsapp: `55${owner.telefoneDigits}`,
      imageUrls: [fakeLogoDataUri('📦', '#8d6e63')],
      active: it.active,
      approved: it.approved,
      reviewed: it.approved,
      featured: false,
      paymentStatus: it.paymentStatus,
      pricePerDay: 1.0,
      minDays: 30,
      plannedActiveDays: 30,
      paymentCreatedAt,
      ownerUid: owner.id,
      ownerEmail: `${owner.cpf}@cpf.local`,
      ownerName: owner.nome,
      orgId: SANDBOX_ORG_ID,
      seedTag: SEED_TAG,
      updatedAt: new Date(),
    }));
    console.log(`  ${it.id}: ${it.title} (active=${it.active}, approved=${it.approved})`);
  }
}

/* ============================ Orquestração ============================ */

async function main() {
  const step = process.argv[2] || 'all';
  console.log(`Seed Oficial Sandbox — org=${SANDBOX_ORG_ID} step=${step}`);
  await assertSandboxOrg();

  if (step === 'team' || step === 'all') {
    await seedTeam();
  }

  let associados = null;
  let mirins = null;
  if (step === 'associados' || step === 'all') {
    associados = await seedAssociados();
    mirins = await seedMirins();
    await waitForAsaasSync([...associados, ...mirins].map((u) => u.id));
  }

  if (step === 'repairAsaasLinks') {
    const allIds = [
      ...Array.from({ length: 35 }, (_, i) => `sandbox_assoc_${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 5 }, (_, i) => `sandbox_mirim_${String(i + 1).padStart(2, '0')}`),
    ];
    await repairAsaasLinks(allIds);
  }

  if (step === 'financeFollowup' || step === 'all') {
    if (!associados) {
      // Reexecução isolada deste passo: reconstrói a lista a partir do Firestore.
      associados = [];
      for (let i = 1; i <= 35; i++) {
        const id = `sandbox_assoc_${String(i).padStart(2, '0')}`;
        const doc = await firestoreGet(`users/${id}`);
        if (doc) associados.push({ id, cpf: doc.cpf, nome: doc.nome, telefoneDigits: (doc.telefone || '').replace(/\D/g, ''), planType: doc.planType, scenario: doc.seedScenario });
      }
    }
    await seedFinanceFollowup(associados);
  }

  if (step === 'events' || step === 'all') {
    await seedEvents('sandbox_master_01');
  }
  if (step === 'partners' || step === 'all') {
    await seedPartners('sandbox_master_01');
  }
  if (step === 'classificados' || step === 'all') {
    if (!associados) {
      associados = [];
      for (let i = 1; i <= 35; i++) {
        const id = `sandbox_assoc_${String(i).padStart(2, '0')}`;
        const doc = await firestoreGet(`users/${id}`);
        if (doc) associados.push({ id, cpf: doc.cpf, nome: doc.nome, telefoneDigits: (doc.telefone || '').replace(/\D/g, ''), scenario: doc.seedScenario });
      }
    }
    await seedClassificados(associados);
  }

  console.log('\nSeed concluído. Senha padrão de todas as contas fictícias criadas: ' + DEMO_PASSWORD);
}

main().catch((e) => {
  console.error('\nERRO:', e.message);
  if (e.data) console.error(JSON.stringify(e.data, null, 2));
  process.exit(1);
});
