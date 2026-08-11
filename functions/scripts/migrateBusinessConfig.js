#!/usr/bin/env node
// functions/scripts/migrateBusinessConfig.js — Evolução Multi-Tenant (Fase 4).
//
// Migração pontual (não um seed, não idempotente-por-design como
// seedSandboxTenant.js — roda uma vez por organização já existente) que
// popula os campos de negócio que antes eram constante de módulo
// compartilhada (functions/index.js: PLAN_VALUE/PLAN_CYCLE/PLAN_LABEL,
// interest fixo, regras de leilão/classificados/carência) e passaram a viver
// em organizations/{orgId}.billing/business — ver CLAUDE.md, "Evolução
// Multi-Tenant". Sem isto, os tenants existentes (CCBMG e Sandbox) ficariam
// SEM nenhum plano configurado assim que o código parar de usar as
// constantes antigas — resolvePlanValue() lançaria erro em toda cobrança nova.
//
// Cada organização recebe EXATAMENTE os valores que já usava (via as
// constantes agora removidas do código) — nenhum valor comercial muda nesta
// migração, só muda ONDE o valor mora.
//
// notificationEmails: auditado contra produção antes de escrever este
// script — ao contrário do que CLAUDE.md registrava (Fase 3.11), NENHUMA das
// duas organizações tinha esse campo configurado de verdade em produção
// (confirmado via leitura direta do Firestore em 2026-08-11). Sem setá-lo
// aqui, remover o fallback de e-mails pessoais do código (ver
// functions/index.js) pararia silenciosamente os relatórios/alertas do
// CCBMG — por isso esta migração é pré-requisito do deploy da Fase 4, não
// só um "nice to have".
//
// AUTENTICAÇÃO: mesmo padrão de seedSandboxTenant.js — access token do
// operador já logado via `gcloud auth login`, sem Application Default
// Credentials nem chave de serviço.
//
// Uso:
//   node functions/scripts/migrateBusinessConfig.js --dry-run   (padrão: mostra o diff, não escreve)
//   node functions/scripts/migrateBusinessConfig.js --apply     (escreve de verdade)
//
// Requer Node 22 (fetch global).

const { execSync } = require('child_process');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'clubecavalobonfim';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const APPLY = process.argv.includes('--apply');

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

/* ============================ Firestore REST (mesmo encode/decode de seedSandboxTenant.js) ============================ */

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
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

// updateMask explícito — nunca overwrite total (mesma razão de
// upsertUserFields em seedSandboxTenant.js: organizations/{orgId} é
// co-dono de várias telas administrativas, um PATCH sem máscara apagaria
// campos que esta migração não tem nenhuma intenção de tocar).
async function firestorePatchFields(path, data) {
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await gfetch(`${FIRESTORE_BASE}/${path}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
}

/* ============================ Valores a migrar ============================ */

// Mesmos números que PLAN_VALUE/PLAN_CYCLE/PLAN_LABEL/resolvePlanValue/
// interest fixo/regras de leilão-classificados-carência usavam hardcoded —
// ver functions/index.js antes desta fase (git blame). Nenhum valor
// comercial muda, só passa a morar no documento da organização.
const BUSINESS_DEFAULTS = {
  billing: {
    plans: [
      { id: 'mensal', label: 'Mensal', cycle: 'MONTHLY', price: 30 },
      { id: 'trimestral', label: 'Trimestral', cycle: 'QUARTERLY', price: 85 },
      { id: 'semestral', label: 'Semestral', cycle: 'SEMIANNUALLY', price: 170 },
    ],
    mirimDiscountRatio: 0.5,
    lateInterestRate: 0.01,
  },
  business: {
    membership: { renewSoonDays: 5, graceOverdueDays: 5 },
    classifieds: { pricePerDay: 1, minimumDays: 30 },
    auction: {
      minBidIncrementPct: 0.02,
      antiSniperExtensionMs: 120000,
      commissionClubePct: 0.05,
      commissionSistemaPct: 0.05,
    },
  },
};

const TENANTS = [
  {
    orgId: 'org_bonfim',
    label: 'CCBMG (produção real)',
    // Recipientes reais já usados como fallback hardcoded no código antes
    // desta fase (functions/index.js) — preserva o comportamento atual.
    notificationEmails: ['waldiney.serafim@gmail.com', 'mpmarquesnutri@gmail.com'],
    // whatsapp já está configurado em produção (aba Comunicação do Painel
    // Master) — não sobrescreve, só confirma no relatório do dry-run.
  },
  {
    orgId: 'org_teste_etapa10',
    label: 'Sandbox oficial da plataforma',
    // Array vazio explícito — ambiente de demonstração não deve gerar
    // ruído em inbox real nenhuma (mesma intenção documentada na Fase 3.11,
    // agora de fato aplicada, e não só descrita).
    notificationEmails: [],
    // Sandbox não tinha `whatsapp` configurado (só `telefone`, fictício) —
    // usa o mesmo número fictício pra branding.js ter algo pra mostrar em
    // vez de cair no fallback estático (número real do CCBMG).
    whatsapp: '5538988887777',
  },
];

async function migrateOne(tenant) {
  const path = `organizations/${tenant.orgId}`;
  const existing = await firestoreGet(path);
  if (!existing) {
    console.log(`✗ ${tenant.orgId}: organização não encontrada — pulando.`);
    return;
  }

  const patch = {};
  const diff = [];

  if (existing.billing) {
    diff.push(`  billing: já existe, PRESERVADO sem alteração (idempotente) — ${JSON.stringify(existing.billing).slice(0, 120)}...`);
  } else {
    patch.billing = BUSINESS_DEFAULTS.billing;
    diff.push(`  billing: (ausente) → ${JSON.stringify(BUSINESS_DEFAULTS.billing)}`);
  }

  if (existing.business) {
    diff.push(`  business: já existe, PRESERVADO sem alteração (idempotente) — ${JSON.stringify(existing.business).slice(0, 120)}...`);
  } else {
    patch.business = BUSINESS_DEFAULTS.business;
    diff.push(`  business: (ausente) → ${JSON.stringify(BUSINESS_DEFAULTS.business)}`);
  }

  if (Array.isArray(existing.notificationEmails)) {
    diff.push(`  notificationEmails: já existe, PRESERVADO sem alteração — ${JSON.stringify(existing.notificationEmails)}`);
  } else {
    patch.notificationEmails = tenant.notificationEmails;
    diff.push(`  notificationEmails: (ausente) → ${JSON.stringify(tenant.notificationEmails)}`);
  }

  if (tenant.whatsapp) {
    if (existing.whatsapp) {
      diff.push(`  whatsapp: já existe, PRESERVADO sem alteração — ${JSON.stringify(existing.whatsapp)}`);
    } else {
      patch.whatsapp = tenant.whatsapp;
      diff.push(`  whatsapp: (ausente) → ${JSON.stringify(tenant.whatsapp)}`);
    }
  }

  console.log(`\n${tenant.label} (${tenant.orgId}):`);
  diff.forEach((l) => console.log(l));

  if (!Object.keys(patch).length) {
    console.log('  → nada a fazer, já totalmente migrada.');
    return;
  }

  if (!APPLY) {
    console.log('  → [dry-run] nenhuma escrita realizada. Rode com --apply para gravar.');
    return;
  }

  patch.updatedAt = new Date();
  await firestorePatchFields(path, patch);
  console.log('  → gravado com sucesso.');
}

(async () => {
  console.log(`Evolução Multi-Tenant — migração de configuração de negócio (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`Projeto: ${PROJECT_ID}\n`);
  for (const tenant of TENANTS) {
    await migrateOne(tenant);
  }
  console.log('\nConcluído.');
})().catch((e) => {
  console.error('Erro na migração:', e.message, e.data || '');
  process.exit(1);
});
