const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const { createOrganizationResolver } = require('./lib/organization');
const { createAuthorizationHelpers } = require('./lib/authorization');
const { createRoleResolver } = require('./lib/roles');
const { getBillingProvider } = require('./lib/billing');
const { PLATFORM_ROLES, createPlatformResolver, createPlatformAuthorizationHelpers } = require('./lib/platform');
const { createProvisioningService } = require('./lib/provisioning');
const { createDomainsService } = require('./lib/domains');
const { createFeatureService } = require('./lib/features');
const { computePublicBrandingProjection } = require('./lib/organizationPublicSync');
const { runAuthBackup } = require('./lib/authBackup');

const ASAAS_SECRET                = 'projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest';
const ASAAS_WEBHOOK_TOKEN         = 'projects/clubecavalobonfim/secrets/asaas-webhook-token/versions/latest';
const ASAAS_AUCTION_WEBHOOK_TOKEN = 'projects/clubecavalobonfim/secrets/asaas-auction-webhook-token/versions/latest';
// Fase 3.7 (Sandbox multi-tenant) — segunda conta Asaas, exclusiva do tenant
// Sandbox oficial da plataforma (organizations/{orgId}.billingEnvironment ===
// "sandbox"). Outbound já era 100% resolvido por organização via
// getProviderForOrg() (lib/billing) desde a Fase 3.4 — só o webhook (inbound)
// ainda assumia 1 conta/token global, porque o Asaas manda o POST pra 1
// conta/token só, sem informação de organização ANTES de validar o token (ver
// getDefaultProvider). Como o Asaas já configura webhook por CONTA (não por
// payload), e esta plataforma tem exatamente 1 tenant Sandbox (não N), a
// mesma solução de auctionAsaasWebhook (endpoint dedicado + secret dedicado)
// resolve sem precisar rotear por orgId em tempo de requisição.
const ASAAS_SANDBOX_SECRET         = 'projects/clubecavalobonfim/secrets/asaas-sandbox-api-key/versions/latest';
const ASAAS_SANDBOX_WEBHOOK_TOKEN  = 'projects/clubecavalobonfim/secrets/asaas-sandbox-webhook-token/versions/latest';

// Remove prefixo 55 se o número já vier com código do país (13 dígitos)
// Asaas espera número local: DDD + número (11 dígitos para celular)
function formatPhoneForAsaas(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (!d) return undefined;
  if (d.length === 13 && d.startsWith('55')) return d.slice(2);
  return d;
}

admin.initializeApp();
const db = admin.firestore();
const secretClient = new SecretManagerServiceClient();

async function getSecret(name) {
  const [version] = await secretClient.accessSecretVersion({ name });
  return version.payload.data.toString();
}

/* =========================================================================
   INFRAESTRUTURA COMPARTILHADA (Fase 2B)
   — Organization Resolver, Authorization Helpers, resolução de papel e Billing
   Provider. Nenhuma regra de negócio do CCBMG mora em lib/ — só mecanismo.
   ========================================================================= */

const organizationResolver = createOrganizationResolver({ db });

// Mesmo vocabulário e mesma ordem de prioridade que shared/core/auth/roles.js
// usa do lado cliente (firebase.js) — elimina o drift que mapRoleServer() tinha
// (faltava o ramo "adminView", então um Admin View virava admin pleno no servidor).
const mapRole = createRoleResolver(
  [
    ['master', (n) => n.includes('master')],
    ['adminView', (n) => n.includes('admin') && n.includes('view')],
    ['admin', (n) => n.includes('admin')],
    ['operador', (n) => n.includes('operador')],
    ['participanteLeilao', (n) => n.includes('participante')],
  ],
  'associado'
);

const auth = createAuthorizationHelpers({ organizationResolver, mapRole });

// Plano de identidade de PLATAFORMA (Fase 3.2) — deliberadamente sem organizationResolver
// nenhum: platformAdmins/{uid} nunca tem orgId, então não há nada pra resolver aqui.
const platformResolver = createPlatformResolver({ db });
const platformAuth = createPlatformAuthorizationHelpers({ platformResolver });

// Fase 3.3 — mecanismo oficial de provisionamento de organizações. Puro
// Firestore+Auth (sem Secret Manager/e-mail — isso fica com quem chama, ver
// callable provisionOrganization abaixo), testável com fakes.
const provisioningService = createProvisioningService({
  db,
  authAdmin: admin.auth(),
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});

// Fase 3.5 — registro hostname → orgId, único escritor de domains/{hostname}.
const domainsService = createDomainsService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
});

// Fase 3.8 — camada única de resolução de Feature Flags. Nenhuma outra parte
// deste arquivo deve ler featureFlags/{flagKey} direto do Firestore — sempre
// via featureService (ver lib/features.js pro porquê).
const featureService = createFeatureService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  deleteField: () => admin.firestore.FieldValue.delete(),
});

/** Provider da organização do documento/usuário em questão (resolve org → provider). */
async function getProviderForOrg(orgId) {
  const org = orgId ? await organizationResolver.getOrganization(orgId) : null;
  return getBillingProvider({ org, getSecret, defaultSecretName: ASAAS_SECRET });
}

// Fase 3.6 (patch de segurança): confirma que um asaasPaymentId recebido do
// cliente pertence de verdade ao uid já validado (assertCallerCanManageTarget),
// antes de deixar qualquer callable agir sobre ele. Sem isso, um admin da
// organização A podia consultar/cancelar a cobrança de um uid de outra
// organização só adivinhando/reaproveitando um asaasPaymentId — hoje todas as
// organizações dividem a mesma conta Asaas (ver CLAUDE.md), então o ID por si
// só não prova posse.
async function assertPaymentBelongsToUid(uid, asaasPaymentId) {
  const invSnap = await db.collection('users').doc(uid).collection('financeInvoices')
    .where('asaasPaymentId', '==', asaasPaymentId).limit(1).get();
  if (invSnap.empty) {
    throw new functions.https.HttpsError('permission-denied', 'Esta cobrança não pertence a este associado.');
  }
  return invSnap.docs[0];
}

// Fase 3.6 (hardening): auditoria server-side de mutações de organização de
// alto impacto (exclusão, redefinição de senha, cobranças) — mesmo
// schema/coleção que o logAction() client-side já usa (shared/core/tenant/
// audit.js), só que gravado do próprio servidor pra garantir que ações
// irreversíveis/financeiras fiquem registradas mesmo que o cliente nunca
// chame logAction() por conta própria.
async function writeOrgAuditLog(action, details, context, orgId) {
  try {
    await db.collection('systemLogs').add({
      userId: context.auth?.uid || null,
      userEmail: context.auth?.token?.email || null,
      orgId,
      action,
      details: details || {},
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writeOrgAuditLog: falha ao gravar auditoria (ignorado):', e.message);
  }
}

/**
 * Provider "default" da plataforma — usado quando ainda não se sabe a
 * organização (webhooks do Asaas chegam pra 1 conta/token só, antes de saber
 * a qual venda/pagamento pertencem — ver auctionAsaasWebhook/asaasWebhook) ou
 * como fallback para documentos de leilão anteriores à Fase 2C que ainda não
 * passaram pelo backfillLeilaoOrgId. Resolve para o mesmo secret único de
 * sempre — comportamento idêntico ao anterior, só que através do Billing
 * Provider em vez de fetch() direto.
 */
async function getDefaultProvider() {
  return getBillingProvider({ org: null, getSecret, defaultSecretName: ASAAS_SECRET });
}

// Fase 3.6, Etapa 11 do Deploy Controlado — backup semanal do Firebase Auth
// (ver lib/authBackup.js). Domingo de madrugada: fora do horário de maior
// uso, mesmo raciocínio das outras rotinas agendadas deste arquivo.
exports.backupAuthUsers = functions.pubsub.schedule('0 3 * * 0')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const bucket = admin.storage().bucket();
    const { count, path } = await runAuthBackup({ auth: admin.auth(), bucket });
    console.log(`backupAuthUsers: ${count} usuário(s) exportado(s) para ${path}`);
  });

// Função agendada para rodar a cada 10 minutos (para teste)
exports.sendDailyPaymentReport = functions.pubsub.schedule('0 8 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async (context) => {
    try {
      console.log('Iniciando envio de relatório diário de vencimentos');

      const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');
      const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');

      // Isolamento por organização: cada org processa só os próprios `users`
      // (antes desta fase, a rotina lia `users` inteiro sem filtro nenhum).
      const orgsSnap = await db.collection('organizations').get();
      const orgs = orgsSnap.empty
        ? [{ id: 'org_bonfim', nome: 'Clube do Cavalo Bonfim MG' }] // fallback: nenhuma org cadastrada ainda (estado pré-Fase 0)
        : orgsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.ativo !== false);

      const reportsByOrg = [];

      for (const org of orgs) {
        const usersSnapshot = await db.collection('users').where('orgId', '==', org.id).get();

        const expiring5Days = [];
        const dueToday = [];
        const overdue5to10Days = [];
        const overdueMore10Days = [];

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        for (const userDoc of usersSnapshot.docs) {
          const userData = userDoc.data();
          const uid = userDoc.id;

          if (userData.ativo === false) continue;

          let invDocs = [];
          try {
            const invSnap = await db.collection('users').doc(uid).collection('financeInvoices').get();
            invDocs = invSnap.docs.map(x => ({ id: x.id, ...x.data() }));
          } catch (errInv) {
            console.warn('Falha ao ler financeInvoices de', uid, errInv);
            continue;
          }

          let summary = {};
          try {
            const sumSnap = await db.collection('users').doc(uid).collection('finance').doc('summary').get();
            if (!sumSnap.empty) summary = sumSnap.data();
          } catch (errSum) {
            console.warn('Falha ao ler summary de', uid, errSum);
          }

          const m = computeMembership({ invoices: invDocs, summary });
          if (m.listCode === 'isento') continue;

          let nextDue = m.nextDue;
          if (!nextDue) {
            const allDueDates = invDocs.map(i => {
              const dueMs = i.dueDate?.toMillis?.() ?? (i.dueDate ? new Date(i.dueDate).getTime() : null);
              return dueMs;
            }).filter(d => d !== null);

            const allPlanEnds = invDocs.map(i => {
              const endMs = i.planEnd?.toMillis?.() ?? (i.planEnd ? new Date(i.planEnd).getTime() : null);
              return endMs;
            }).filter(d => d !== null);

            if (allDueDates.length > 0) nextDue = Math.min(...allDueDates);
            else if (allPlanEnds.length > 0) nextDue = Math.max(...allPlanEnds);
          }

          if (!nextDue) continue;

          const dueDate = new Date(nextDue);
          const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
          const daysDiff = Math.floor((dueDay - today) / (24 * 3600 * 1000));

          const userInfo = {
            nome: userData.nome || 'Sem nome',
            apelido: userData.apelido || '',
            cpf: userData.cpf || '',
            telefone: userData.telefone || '',
            vencimento: formatDateBR(dueDate),
            diasAtraso: daysDiff
          };

          if (daysDiff === 0) dueToday.push(userInfo);
          else if (daysDiff > 0 && daysDiff <= 5) expiring5Days.push(userInfo);
          else if (daysDiff < -10) overdueMore10Days.push(userInfo);
          else if (daysDiff < 0 && daysDiff >= -10) overdue5to10Days.push(userInfo);
        }

        reportsByOrg.push({ org, expiring5Days, dueToday, overdue5to10Days, overdueMore10Days });
      }

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPassword }
      });

      // Patch de segurança (Fase 3.6): um e-mail POR ORGANIZAÇÃO, só pros
      // destinatários daquela organização — antes desta correção, o relatório
      // unia os e-mails de TODAS as organizações e mandava um e-mail só com
      // os blocos de TODAS elas pra TODOS os destinatários (vazamento
      // cross-tenant de nome/CPF/telefone/vencimento de inadimplência,
      // dormant só porque havia 1 organização real até agora). Cada
      // organização pode declarar `notificationEmails` no próprio documento
      // (organizations/{orgId}); sem isso, cai no fallback global de sempre
      // — 100% retrocompatível com o CCBMG, que ainda não tem esse campo.
      for (const report of reportsByOrg) {
        const { org } = report;
        const emails = Array.isArray(org.notificationEmails) && org.notificationEmails.length
          ? org.notificationEmails
          : ['waldiney.serafim@gmail.com', 'mpmarquesnutri@gmail.com'];

        await transporter.sendMail({
          from: '"Clube do Cavalo Bonfim MG" <contato@clubedocavalobonfim.com.br>',
          to: emails.join(', '),
          subject: `${org.nome || org.id} - Relatório de Associados - ${formatDateBR(now())}`,
          html: generateEmailHtml([report]),
        });
      }

      console.log('Relatório diário enviado com sucesso');
      return null;
    } catch (error) {
      console.error('Erro ao enviar relatório diário:', error);
      throw error;
    }
  });

// Função auxiliar para calcular membership (mesma lógica do frontend)
function computeMembership({ invoices = [], summary = {} }) {
  if (summary.exempt === true) {
    const untilMs = summary.exemptUntil?.toMillis?.() ?? (summary.exemptUntil ? new Date(summary.exemptUntil).getTime() : null);
    if (!untilMs || untilMs > Date.now()) {
      return { listCode: 'isento', listBadge: 'Isento', detail: 'isento', nextDue: null };
    }
  }

  const unpaid = invoices.filter(i => {
    const s = String(i.status || '').toLowerCase();
    return !['pago', 'paga', 'paid', 'cancelado', 'estornado'].includes(s);
  });

  let earliestDue = null;
  for (const inv of unpaid) {
    const dueMs = inv.dueDate?.toMillis?.() ?? (inv.dueDate ? new Date(inv.dueDate).getTime() : null);
    if (dueMs && (earliestDue === null || dueMs < earliestDue)) earliestDue = dueMs;
  }

  if (earliestDue && earliestDue < Date.now()) {
    const daysOver = Math.floor((Date.now() - earliestDue) / (24 * 3600 * 1000));
    const detail = daysOver <= 10 ? 'atrasado' : 'vencido';
    return { listCode: 'pendente', listBadge: 'Pendente', detail, nextDue: earliestDue };
  }

  const paid = invoices.filter(i => ['pago', 'paid'].includes(String(i.status || '').toLowerCase()));
  let lastPaidEnd = null;
  if (paid.length) {
    const paidSorted = paid.sort((a, b) => {
      const aEnd = a.planEnd?.toMillis?.() ?? (a.planEnd ? new Date(a.planEnd).getTime() : 0);
      const bEnd = b.planEnd?.toMillis?.() ?? (b.planEnd ? new Date(b.planEnd).getTime() : 0);
      return bEnd - aEnd;
    });
    lastPaidEnd = paidSorted[0]?.planEnd?.toMillis?.() ?? (paidSorted[0]?.planEnd ? new Date(paidSorted[0]?.planEnd).getTime() : null);
  }

  if (lastPaidEnd && lastPaidEnd > Date.now()) {
    return { listCode: 'em_dia', listBadge: 'Em dia', detail: 'em_dia', nextDue: lastPaidEnd };
  }

  if (earliestDue && earliestDue > Date.now()) {
    return { listCode: 'em_dia', listBadge: 'Em dia', detail: 'em_dia', nextDue: earliestDue };
  }

  return { listCode: 'inativo', listBadge: 'Inativo', detail: 'inativo', nextDue: null };
}

// Escapa entidades HTML para evitar injeção no template de email
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Função auxiliar para formatar data em português
function formatDateBR(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('pt-BR');
}

function now() { return new Date(); }

// Função auxiliar para gerar HTML do email — recebe 1 bloco por organização
// (reportsByOrg), renderizados em seções separadas, para nunca misturar dados
// de organizações diferentes no mesmo relatório.
function generateEmailHtml(reportsByOrg) {
  const section = (title, cls, rows, withAtraso) => rows.length ? `
    <h2 class="${cls}">${title} (${rows.length})</h2>
    <table>
      <thead><tr><th>Nome</th><th>Apelido</th><th>Telefone</th><th>Vencimento</th>${withAtraso ? '<th>Dias de Atraso</th>' : ''}</tr></thead>
      <tbody>
        ${rows.map(user => `
          <tr>
            <td>${escHtml(user.nome)}</td>
            <td>${escHtml(user.apelido || '—')}</td>
            <td>${escHtml(user.telefone || '—')}</td>
            <td>${escHtml(user.vencimento)}</td>
            ${withAtraso ? `<td>${Math.abs(user.diasAtraso)} dias</td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>` : '';

  const orgBlocks = reportsByOrg.map(({ org, expiring5Days, dueToday, overdue5to10Days, overdueMore10Days }) => {
    const isEmpty = !expiring5Days.length && !dueToday.length && !overdue5to10Days.length && !overdueMore10Days.length;
    return `
    <div style="margin-top:30px;padding-top:10px;border-top:2px solid #eee;">
      <h1 style="font-size:1.2rem;text-align:left;">${escHtml(org.nome || org.id)}</h1>
      ${section('Vence Hoje', 'danger', dueToday, false)}
      ${section('À Vencer em 5 Dias', 'warning', expiring5Days, false)}
      ${section('Vencido a mais de 10 Dias', 'danger', overdueMore10Days, true)}
      ${section('Vencido entre 5 e 10 Dias', 'warning', overdue5to10Days, true)}
      ${isEmpty ? '<p style="text-align: center; color: #666; margin-top: 15px;">Nenhum associado com vencimento próximo encontrado.</p>' : ''}
    </div>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 10px; }
    h2 { color: #666; border-bottom: 2px solid #ddd; padding-bottom: 10px; margin-top: 30px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #f8f9fa; font-weight: bold; }
    tr:hover { background-color: #f5f5f5; }
    .warning { color: #f59f00; }
    .danger { color: #dc3545; }
    .success { color: #198754; }
    .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="text-align:center;">Relatório de Associados</h1>
    <p style="text-align: center; color: #666;">Data: ${formatDateBR(now())}</p>
    ${orgBlocks}
    <div class="footer">
      <p>Relatório gerado automaticamente pelo sistema</p>
    </div>
  </div>
</body>
</html>
  `;
}

/* =======================================================================
   INTEGRAÇÃO FINANCEIRA — via Billing Provider (Fase 2B)
   Nenhuma Cloud Function chama api.asaas.com diretamente a partir daqui;
   tudo passa por getProviderForOrg()/getDefaultProvider() (lib/billing).
   ======================================================================= */

// Recalcula e persiste finance/summary a partir das financeInvoices (espelha refreshSummaryFromInvoices do frontend)
async function updateFinanceSummary(uid) {
  const invSnap = await db.collection('users').doc(uid)
    .collection('financeInvoices').orderBy('dueDate', 'asc').get();
  const invoices = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const isPaid = s => ['pago', 'paga', 'paid'].includes(String(s || '').toLowerCase());

  const paid = invoices.filter(i => isPaid(i.status));
  paid.sort((a, b) => {
    const aMs = a.paidAt?.toMillis?.() ?? a.recordedAt?.toMillis?.() ?? 0;
    const bMs = b.paidAt?.toMillis?.() ?? b.recordedAt?.toMillis?.() ?? 0;
    return bMs - aMs;
  });

  const latestPaid = paid[0] || null;
  let lastPayment = null, lastAmount = null, activeUntil = null;

  if (latestPaid) {
    lastPayment = latestPaid.paidAt || latestPaid.recordedAt || null;
    lastAmount  = latestPaid.amount ?? null;

    if (latestPaid.planEnd) {
      const end = latestPaid.planEnd?.toDate?.() ?? new Date(latestPaid.planEnd);
      const au  = new Date(end);
      au.setDate(au.getDate() + 10);
      activeUntil = admin.firestore.Timestamp.fromDate(au);
    }
  }

  const open = invoices.filter(i =>
    !['pago', 'paga', 'paid', 'cancelado', 'estornado'].includes(String(i.status || '').toLowerCase())
  );
  const nextDue = open.length ? (open[0].dueDate || null) : null;

  await db.collection('users').doc(uid).collection('finance').doc('summary').set({
    lastPayment:  lastPayment  || null,
    lastAmount:   lastAmount   ?? null,
    nextDue:      nextDue      || null,
    activeUntil:  activeUntil  || null,
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Retorna próximo dia 10 como YYYY-MM-DD (se hoje já passou do dia 10, vai pro mês seguinte)
function getNextDueDate() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let due = new Date(today.getFullYear(), today.getMonth(), 10);
  if (due <= today) due = new Date(today.getFullYear(), today.getMonth() + 1, 10);
  return due.toISOString().slice(0, 10);
}

// Retorna data de fim do plano: último dia do período (mensal=+1m, trimestral=+3m, semestral=+6m)
function calculatePlanEnd(startDate, planType) {
  const d = new Date(startDate);
  const months = planType === 'trimestral' ? 3 : planType === 'semestral' ? 6 : 1;
  return new Date(d.getFullYear(), d.getMonth() + months, 0); // dia 0 = último dia do mês anterior
}

// Sincroniza pagamento manual do Firebase → provider financeiro da organização do uid.
// Só executa se a fatura NÃO tem asaasPaymentId (ou seja, não veio do webhook)
async function syncManualPaymentToAsaas(uid, invoiceRef, invoiceData) {
  if (invoiceData.asaasPaymentId) return; // já sincronizado via webhook

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return;
  const userData = userSnap.data();
  if (!userData.asaasId || !userData.asaasSubscriptionId) return;

  const provider = await getProviderForOrg(userData.orgId);

  const dueDateMs = invoiceData.dueDate?.toMillis?.()
    ?? (invoiceData.dueDate ? new Date(invoiceData.dueDate).getTime() : null);
  if (!dueDateMs) return;

  const dueDateStr = new Date(dueDateMs).toISOString().slice(0, 10);

  const [pending, overdue] = await Promise.all([
    provider.listCharges({ subscriptionId: userData.asaasSubscriptionId, status: 'PENDING' }),
    provider.listCharges({ subscriptionId: userData.asaasSubscriptionId, status: 'OVERDUE' }),
  ]);
  const allCharges = [...pending, ...overdue];

  const charge = allCharges.find(c => c.dueDate === dueDateStr);
  if (!charge) {
    console.warn(`syncManualPaymentToAsaas: cobrança não encontrada para uid=${uid} dueDate=${dueDateStr}`);
    return;
  }

  const paidAt = invoiceData.paidAt?.toDate?.() ?? invoiceData.recordedAt?.toDate?.() ?? new Date();
  await provider.receiveInCash(charge.providerId, {
    paymentDate: paidAt.toISOString().slice(0, 10),
    value: invoiceData.amount || charge.value,
  });

  // Salva asaasPaymentId na fatura para idempotência (+ billingType/invoiceNumber para exibição no painel)
  await invoiceRef.update({
    asaasPaymentId: charge.providerId,
    billingType:    charge.billingType || null,
    invoiceNumber:  charge.invoiceNumber || null,
  });
  console.log(`syncManualPaymentToAsaas: uid=${uid} charge=${charge.providerId} marcado como pago no Asaas`);
}

// Cria ou atualiza uma financeInvoice a partir de um payment normalizado do provider
// (idempotente por asaasPaymentId). Usado pelo webhook, pela sincronização manual sob
// demanda, pela reconciliação diária e pelo cancelamento/reativação de associado —
// única fonte dessa lógica para as rotinas não divergirem.
async function upsertInvoiceFromAsaasPayment(uid, normalizedPayment) {
  const invoicesRef = db.collection('users').doc(uid).collection('financeInvoices');

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { action: 'skipped', reason: 'user_not_found' };

  const planType  = String(userSnap.data().planType || 'mensal').toLowerCase().trim();
  const dueDate   = new Date(normalizedPayment.dueDate);
  const planStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
  const planEnd   = calculatePlanEnd(planStart, planType);
  const nowTs     = admin.firestore.FieldValue.serverTimestamp();
  const status    = normalizedPayment.status;

  const paymentPayload = {
    status,
    amount:         normalizedPayment.value,
    asaasPaymentId: normalizedPayment.providerId,
    invoiceUrl:     normalizedPayment.invoiceUrl || null,
    billingType:    normalizedPayment.billingType || null,
    invoiceNumber:  normalizedPayment.invoiceNumber || null,
    planType,
    planStart:      admin.firestore.Timestamp.fromDate(planStart),
    planEnd:        admin.firestore.Timestamp.fromDate(planEnd),
    updatedAt:      nowTs,
  };

  // Só grava data de pagamento quando o pagamento é real — nunca usar "agora" como fallback
  // para uma cobrança que não foi paga (isso carimbaria uma data de pagamento falsa).
  if (status === 'pago') {
    const paidAt = new Date(normalizedPayment.paymentDate || Date.now());
    paymentPayload.paidAt = admin.firestore.Timestamp.fromDate(paidAt);
  }

  // 1) Já existe fatura vinculada a este payment.id? Converge (upsert).
  const byPaymentId = await invoicesRef.where('asaasPaymentId', '==', normalizedPayment.providerId).limit(1).get();
  if (!byPaymentId.empty) {
    await byPaymentId.docs[0].ref.update(paymentPayload);
    return { action: 'updated', invoiceId: byPaymentId.docs[0].id };
  }

  // 2) Fatura pré-existente sem asaasPaymentId ainda, mesma dueDate e em aberto — vincula.
  const existingSnap = await invoicesRef
    .where('dueDate', '==', admin.firestore.Timestamp.fromDate(dueDate))
    .where('status', 'in', ['em_aberto', 'atrasado', 'vencido'])
    .limit(1).get();

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.update(paymentPayload);
    return { action: 'updated', invoiceId: existingSnap.docs[0].id };
  }

  // 3) Não havia nada — cria uma fatura nova espelhando esta cobrança.
  const newRef = await invoicesRef.add({
    ...paymentPayload,
    dueDate:   admin.firestore.Timestamp.fromDate(dueDate),
    createdAt: nowTs,
  });
  return { action: 'created', invoiceId: newRef.id };
}

// Callable: sincroniza associados sem asaasId da PRÓPRIA organização do chamador.
exports.syncAllAssociadosToAsaas = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);
    const provider = await getProviderForOrg(caller.orgId);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const results = { synced: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (userData.asaasId || userData.ativo === false) {
        results.skipped++;
        continue;
      }

      try {
        const { providerId } = await findOrCreateCustomerForUser(provider, userData);
        await userDoc.ref.update({
          asaasId: providerId,
          asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        results.synced++;
      } catch (err) {
        console.error('Asaas sync error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: err.message });
      }

      await new Promise(r => setTimeout(r, 250));
    }

    console.log('syncAllAssociadosToAsaas result:', results);
    return results;
  });

/**
 * Monta os dados de cliente a partir de um doc `users/{uid}` (regra do CCBMG:
 * associado "mirim" é cobrado no CPF/telefone do responsável) e delega ao
 * Billing Provider — mantém a mesma prioridade de busca (externalReference
 * depois CPF) que findOrCreateAsaasCustomer tinha antes da Fase 2B.
 */
async function findOrCreateCustomerForUser(provider, user) {
  const isMirim = user.categoriaAssociado === 'mirim';
  const cpf = ((isMirim ? user.responsavelCpf : user.cpf) || '').replace(/\D/g, '');
  if (!cpf) throw new Error(isMirim ? 'CPF do responsável ausente' : 'CPF ausente');

  const nome = isMirim
    ? `${(user.nome || 'Associado').trim()} (Mirim) — resp. ${(user.responsavelNome || '').trim()}`
    : (user.nome || 'Associado').trim();
  const telefone = isMirim ? user.responsavelTelefone : user.telefone;

  // Mirim não casa por CPF (o CPF é do responsável — casar por ele encontraria o
  // cliente do responsável, se ele também for associado, em vez de criar um cliente
  // distinto pro mirim). O Asaas permite clientes duplicados por CPF, é seguro criar.
  return provider.findOrCreateCustomer({
    name: nome,
    cpfCnpj: cpf,
    mobilePhone: formatPhoneForAsaas(telefone),
    externalReference: user.uid || undefined,
    allowDocumentFallback: !isMirim,
  });
}

// Trigger: ao criar um novo usuário → cria cliente e assinatura no provider da organização.
exports.onNewAssociadoCriado = functions.firestore
  .document('users/{uid}')
  .onCreate(async (snap, context) => {
    const uid      = context.params.uid;
    const userData = { uid, ...snap.data() };
    const isMirim  = userData.categoriaAssociado === 'mirim';
    const cpfDisponivel = isMirim ? userData.responsavelCpf : userData.cpf;
    if (!cpfDisponivel || userData.ativo === false) return null;

    try {
      const provider = await getProviderForOrg(userData.orgId);
      const { providerId: asaasId, action } = await findOrCreateCustomerForUser(provider, userData);

      // Notificações (WhatsApp + SMS) precisam estar configuradas antes de
      // criar a assinatura, para que a 1ª cobrança já saia com o padrão certo.
      // Extensão específica do provider Asaas — ver lib/billing/asaas.js.
      if (provider.notifications) {
        const notifResult = await provider.notifications.sync(asaasId);
        console.log(`onNewAssociadoCriado: uid=${uid} asaasId=${asaasId} notificações ajustadas=${notifResult.changed}/${notifResult.total}`);
      }

      const planType    = String(userData.planType || 'mensal').toLowerCase().trim();
      const nextDueDate = getNextDueDate();
      const value       = resolvePlanValue(planType, userData.categoriaAssociado);
      const descricao   = `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType] || 'Mensal'}${isMirim ? ' (Mirim)' : ''}`;

      const { providerId: subscriptionId } = await provider.createSubscription({
        customerId: asaasId,
        value,
        nextDueDate,
        cycle: PLAN_CYCLE[planType] || 'MONTHLY',
        description: descricao,
        externalReference: uid,
        interest: { value: 0.01 },
      });

      await snap.ref.update({
        asaasId,
        asaasSyncedAt:              admin.firestore.FieldValue.serverTimestamp(),
        asaasSubscriptionId:        subscriptionId || null,
        asaasSubscriptionSyncedAt:  admin.firestore.FieldValue.serverTimestamp(),
        'asaasSync.lastSyncedAt':   admin.firestore.FieldValue.serverTimestamp(),
        'asaasSync.lastSyncResult': 'ok',
        'asaasSync.lastSyncError':  null,
      });

      console.log(`onNewAssociadoCriado: uid=${uid} asaasId=${asaasId} action=${action} subscriptionId=${subscriptionId}`);
    } catch (err) {
      logger.error('onNewAssociadoCriado error:', uid, err.message);
      // Patch (Fase 3.6): antes, uma falha aqui (Asaas fora do ar, chave
      // expirada) deixava o associado criado sem asaasId/assinatura e SEM
      // NENHUM sinal — só essa linha de console.error, que ninguém observa.
      // Mesmo campo que onAssociadoAtualizado/syncOneAssociado já usam, pra
      // não inventar mecanismo novo — auditCpfs/auditAsaasSync e a tela
      // administrativa já sabem ler asaasSync.lastSyncResult.
      await snap.ref.update({
        'asaasSync.lastSyncedAt':   admin.firestore.FieldValue.serverTimestamp(),
        'asaasSync.lastSyncResult': 'error',
        'asaasSync.lastSyncError':  err.message,
      }).catch((e) => logger.error('onNewAssociadoCriado: falha ao gravar asaasSync.lastSyncError (ignorado):', uid, e.message));
    }

    return null;
  });

/* =======================================================================
   ASAAS — ASSINATURAS
   ======================================================================= */

const PLAN_CYCLE = { mensal: 'MONTHLY', trimestral: 'QUARTERLY', semestral: 'SEMIANNUALLY' };
const PLAN_VALUE = { mensal: 30, trimestral: 85, semestral: 170 };
const PLAN_LABEL = { mensal: 'Mensal', trimestral: 'Trimestral', semestral: 'Semestral' };

// Mirim paga metade do valor do plano normal, cobrado no CPF do responsável
// (categoriaAssociado/responsavelCpf em users/{uid} — mirim não tem login próprio).
function resolvePlanValue(planType, categoriaAssociado) {
  const base = PLAN_VALUE[String(planType || 'mensal').toLowerCase().trim()] || 30;
  return categoriaAssociado === 'mirim' ? base / 2 : base;
}
// Vencimento da 1ª cobrança quando o associado não tem fatura paga anterior
// (pendente/atrasado/novo): hoje + 5 dias, calculado a cada chamada para nunca
// cair no passado (era uma data fixa hardcoded que ficou obsoleta).
function getPendingRestartDate() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().slice(0, 10);
}

// Retorna o planType da fatura mais recente; fallback para userData.planType; default 'mensal'
function detectPlanType(invoices, userPlanType) {
  const paid = invoices.filter(i =>
    ['pago', 'paga', 'paid'].includes(String(i.status || '').toLowerCase())
  );

  const sorted = (paid.length ? paid : invoices).slice().sort((a, b) => {
    const aMs = a.paidAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;
    const bMs = b.paidAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0;
    return bMs - aMs;
  });

  for (const inv of sorted) {
    const pt = String(inv.planType || '').toLowerCase().trim();
    if (PLAN_CYCLE[pt]) return pt;
  }

  const up = String(userPlanType || '').toLowerCase().trim();
  if (PLAN_CYCLE[up]) return up;

  return 'mensal';
}

// Retorna a data de fim do último plano pago (Date | null)
function getLastPlanEndDate(invoices) {
  const paid = invoices.filter(i =>
    ['pago', 'paga', 'paid'].includes(String(i.status || '').toLowerCase())
  );
  if (!paid.length) return null;

  paid.sort((a, b) => {
    const aMs = a.planEnd?.toMillis?.() ?? (a.planEnd ? new Date(a.planEnd).getTime() : 0);
    const bMs = b.planEnd?.toMillis?.() ?? (b.planEnd ? new Date(b.planEnd).getTime() : 0);
    return bMs - aMs;
  });

  const raw = paid[0].planEnd;
  if (!raw) return null;
  return raw?.toDate?.() ?? new Date(raw);
}

// Callable: cria assinaturas no provider para associados com asaasId da PRÓPRIA organização.
exports.createAsaasSubscriptions = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);
    const provider = await getProviderForOrg(caller.orgId);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const results = { created: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (!userData.asaasId || userData.asaasSubscriptionId || userData.ativo === false) {
        results.skipped++;
        continue;
      }

      try {
        const invSnap = await db.collection('users').doc(userDoc.id).collection('financeInvoices').get();
        const invoices = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const planType = detectPlanType(invoices, userData.planType);

        const membership = computeMembership({ invoices, summary: {} });
        let nextDueDate;

        if (membership.listCode === 'em_dia') {
          const planEnd = getLastPlanEndDate(invoices);
          nextDueDate = planEnd ? planEnd.toISOString().slice(0, 10) : getPendingRestartDate();
        } else {
          nextDueDate = getPendingRestartDate();
        }

        const { providerId: subscriptionId } = await provider.createSubscription({
          customerId: userData.asaasId,
          value: resolvePlanValue(planType, userData.categoriaAssociado),
          nextDueDate,
          cycle: PLAN_CYCLE[planType],
          description: `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType]}${userData.categoriaAssociado === 'mirim' ? ' (Mirim)' : ''}`,
          externalReference: userDoc.id,
          interest: { value: 0.01 },
        });

        const updatePayload = {
          asaasSubscriptionId: subscriptionId,
          asaasSubscriptionSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!userData.planType) updatePayload.planType = planType;
        await userDoc.ref.update(updatePayload);
        results.created++;
      } catch (err) {
        console.error('createAsaasSubscriptions error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: err.message });
      }

      await new Promise(r => setTimeout(r, 250));
    }

    console.log('createAsaasSubscriptions result:', results);
    return results;
  });

// Callable: aplica o padrão institucional de notificações aos clientes Asaas
// CONHECIDOS pela própria organização do chamador (join por `asaasId` gravado em
// `users` — antes desta fase, a rotina varria TODOS os clientes da conta Asaas
// inteira, de qualquer organização).
exports.configureAsaasNotifications = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);
    const provider = await getProviderForOrg(caller.orgId);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const withAsaasId = usersSnap.docs.map(d => d.data()).filter(u => u.asaasId);

    const results = { totalClientes: withAsaasId.length, atualizados: 0, ignorados: 0, errors: [] };

    for (const u of withAsaasId) {
      try {
        const { changed } = await provider.notifications.sync(u.asaasId);
        if (changed > 0) results.atualizados++; else results.ignorados++;
      } catch (err) {
        console.error('configureAsaasNotifications error:', u.asaasId, err.message);
        results.errors.push({ asaasId: u.asaasId, nome: u.nome || '—', error: err.message });
      }
      await new Promise(r => setTimeout(r, 150));
    }

    console.log('configureAsaasNotifications result:', results);
    return results;
  });

// Callable (diagnóstico, somente leitura): lista os clientes Asaas conhecidos
// pela PRÓPRIA organização do chamador (mesmo join por asaasId — antes desta
// fase, listava a conta Asaas inteira, de qualquer organização).
exports.listAsaasCustomersRaw = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const customers = usersSnap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => u.asaasId)
      .map(u => ({ id: u.asaasId, name: u.nome || '—', cpfCnpj: u.cpf || '—', externalReference: u.uid }));

    return { total: customers.length, customers };
  });

// Callable (auditoria, somente leitura): confere o padrão institucional de
// notificações nos clientes Asaas da PRÓPRIA organização do chamador.
exports.verifyAsaasNotificationStandard = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);
    const provider = await getProviderForOrg(caller.orgId);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const withAsaasId = usersSnap.docs.map(d => d.data()).filter(u => u.asaasId);

    const counts = {
      totalClientes: 0, totalNotificacoes: 0,
      whatsappAtivo: 0, whatsappInativo: 0,
      smsAtivo: 0, smsInativo: 0,
      emailAtivo: 0, ligacaoAtiva: 0,
    };
    const whatsappInativoPorEvento = {};
    const naoConformes = [];

    for (const u of withAsaasId) {
      counts.totalClientes++;
      try {
        const notifs = await provider.notifications.list(u.asaasId);
        for (const n of notifs) {
          counts.totalNotificacoes++;
          if (n.whatsappEnabledForCustomer) counts.whatsappAtivo++; else {
            counts.whatsappInativo++;
            whatsappInativoPorEvento[n.event] = (whatsappInativoPorEvento[n.event] || 0) + 1;
          }
          if (n.smsEnabledForCustomer) counts.smsAtivo++; else counts.smsInativo++;
          if (n.emailEnabledForCustomer) counts.emailAtivo++;
          if (n.phoneCallEnabledForCustomer) counts.ligacaoAtiva++;

          const isKnownException = !n.whatsappEnabledForCustomer && n.event === 'SEND_LINHA_DIGITAVEL';
          const conforme = n.smsEnabledForCustomer === true &&
            n.emailEnabledForCustomer === false &&
            n.phoneCallEnabledForCustomer === false &&
            (n.whatsappEnabledForCustomer === true || isKnownException);
          if (!conforme) {
            naoConformes.push({ asaasId: u.asaasId, nome: u.nome, notifId: n.id, event: n.event, notif: n });
          }
        }
      } catch (err) {
        naoConformes.push({ asaasId: u.asaasId, nome: u.nome, erro: err.message });
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return { counts, whatsappInativoPorEvento, naoConformes };
  });

// Callable: corrige os telefones no provider para associados com asaasId da PRÓPRIA organização.
exports.fixAsaasPhoneNumbers = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);
    const provider = await getProviderForOrg(caller.orgId);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const results = { updated: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (!userData.asaasId || !userData.telefone) { results.skipped++; continue; }

      const phone = formatPhoneForAsaas(userData.telefone);
      if (!phone) { results.skipped++; continue; }

      try {
        await provider.updateCustomer(userData.asaasId, { mobilePhone: phone });
        results.updated++;
      } catch (err) {
        console.error('fixAsaasPhoneNumbers error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: err.message });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    console.log('fixAsaasPhoneNumbers result:', results);
    return results;
  });

/* =======================================================================
   SINCRONIZAÇÃO AUTOMÁTICA — FLUXOS BIDIRECIONAL
   ======================================================================= */

// Trigger: quando dados cadastrais do associado mudam → atualiza cliente no provider.
exports.onAssociadoAtualizado = functions.firestore
  .document('users/{uid}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    if (!after.asaasId) return null;

    const isMirim         = after.categoriaAssociado === 'mirim';
    const dataChanged     = isMirim
      ? ['nome', 'responsavelNome', 'responsavelCpf', 'responsavelTelefone'].some(f => before[f] !== after[f])
      : ['nome', 'telefone', 'cpf'].some(f => before[f] !== after[f]);
    const ativoToFalse    = before.ativo !== false && after.ativo === false;
    const ativoToTrue     = before.ativo === false && after.ativo !== false;

    if (!dataChanged && !ativoToFalse && !ativoToTrue) return null;

    const uid = context.params.uid;

    try {
      const provider = await getProviderForOrg(after.orgId);

      if (dataChanged) {
        await provider.updateCustomer(after.asaasId, {
          name: isMirim
            ? `${(after.nome || '').trim()} (Mirim) — resp. ${(after.responsavelNome || '').trim()}`
            : (after.nome || '').trim(),
          cpfCnpj: ((isMirim ? after.responsavelCpf : after.cpf) || '').replace(/\D/g, ''),
          mobilePhone: formatPhoneForAsaas(isMirim ? after.responsavelTelefone : after.telefone),
        });
        console.log(`onAssociadoAtualizado: uid=${uid} dados sincronizados`);
      }

      if ((ativoToFalse || ativoToTrue) && after.asaasSubscriptionId) {
        if (ativoToFalse) await provider.cancelSubscription(after.asaasSubscriptionId);
        else await provider.updateSubscriptionStatus(after.asaasSubscriptionId, 'ACTIVE');
        console.log(`onAssociadoAtualizado: uid=${uid} assinatura ${ativoToFalse ? 'INACTIVE' : 'ACTIVE'}`);
      }

      if (ativoToFalse && after.asaasId) {
        const { found, canceled } = await cancelOpenPayments(provider, uid, after.asaasId);
        console.log(`onAssociadoAtualizado: uid=${uid} cobranças canceladas ${canceled}/${found}`);
        await provider.notifications.setEnabled(after.asaasId, false);
        console.log(`onAssociadoAtualizado: uid=${uid} notificações desativadas`);
      }

      if (ativoToTrue && after.asaasId) {
        await provider.notifications.sync(after.asaasId);
        console.log(`onAssociadoAtualizado: uid=${uid} notificações reativadas`);
        const charge = await createImmediateChargeOnReactivation(provider, uid, after);
        console.log(`onAssociadoAtualizado: uid=${uid} cobrança de reativação criada payment=${charge.providerId}`);
      }

      if (ativoToFalse || ativoToTrue) {
        await change.after.ref.update({
          'asaasSync.lastLifecycleAction': ativoToFalse ? 'deactivate' : 'reactivate',
          'asaasSync.lastLifecycleAt':     admin.firestore.FieldValue.serverTimestamp(),
          'asaasSync.lastLifecycleResult': 'ok',
          'asaasSync.lastLifecycleError':  null,
        }).catch(e => logger.warn('onAssociadoAtualizado: falha ao gravar asaasSync (ok)', uid, e.message));
      }
    } catch (err) {
      logger.error('onAssociadoAtualizado error:', uid, err.message);
      if (ativoToFalse || ativoToTrue) {
        await change.after.ref.update({
          'asaasSync.lastLifecycleAction': ativoToFalse ? 'deactivate' : 'reactivate',
          'asaasSync.lastLifecycleAt':     admin.firestore.FieldValue.serverTimestamp(),
          'asaasSync.lastLifecycleResult': 'error',
          'asaasSync.lastLifecycleError':  err.message,
        }).catch(e => logger.warn('onAssociadoAtualizado: falha ao gravar asaasSync (error)', uid, e.message));
      }
    }

    return null;
  });

// Cancela (via provider) todas as cobranças em aberto (PENDING + OVERDUE) de um cliente —
// usado na desativação de associado. Espelha cada cancelamento como 'cancelado' no
// financeInvoices correspondente.
async function cancelOpenPayments(provider, uid, asaasId) {
  const [pending, overdue] = await Promise.all([
    provider.listCharges({ customerId: asaasId, status: 'PENDING' }),
    provider.listCharges({ customerId: asaasId, status: 'OVERDUE' }),
  ]);
  const openPayments = [...pending, ...overdue];

  let canceled = 0;
  for (const payment of openPayments) {
    try {
      await provider.cancelCharge(payment.providerId);
    } catch (err) {
      console.warn(`cancelOpenPayments: falha ao cancelar payment=${payment.providerId} uid=${uid}: ${err.message}`);
      continue;
    }
    canceled++;
    await upsertInvoiceFromAsaasPayment(uid, { ...payment, status: 'cancelado', deleted: true });
  }
  return { found: openPayments.length, canceled };
}

// Cria uma cobrança avulsa imediata ao reativar um associado.
async function createImmediateChargeOnReactivation(provider, uid, after) {
  const planType = String(after.planType || 'mensal').toLowerCase().trim();
  const value = resolvePlanValue(planType, after.categoriaAssociado);
  const today = new Date().toISOString().slice(0, 10);

  const { providerId, raw } = await provider.createCharge({
    customerId: after.asaasId,
    value,
    dueDate: today,
    description: `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType] || 'Mensal'} (reativação)`,
  });

  const normalized = provider.normalizePayment(raw);
  await upsertInvoiceFromAsaasPayment(uid, normalized);
  return { providerId, raw };
}

// Trigger: quando fatura é ATUALIZADA para status pago → baixa cobrança no provider
exports.onInvoicePaid = functions.firestore
  .document('users/{uid}/financeInvoices/{invoiceId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    const beforeStatus = String(before.status || '').toLowerCase();
    const afterStatus  = String(after.status  || '').toLowerCase();

    if (['pago', 'paga', 'paid'].includes(beforeStatus)) return null;
    if (!['pago', 'paga', 'paid'].includes(afterStatus)) return null;

    try {
      await syncManualPaymentToAsaas(context.params.uid, change.after.ref, after);
    } catch (err) {
      logger.error('onInvoicePaid error:', context.params.uid, context.params.invoiceId, err.message);
    }

    return null;
  });

// Trigger: quando fatura é CRIADA já como paga (pagamento imediato pelo admin) → baixa no provider
exports.onInvoiceCreatedPaid = functions.firestore
  .document('users/{uid}/financeInvoices/{invoiceId}')
  .onCreate(async (snap, context) => {
    const data   = snap.data();
    const status = String(data.status || '').toLowerCase();

    if (!['pago', 'paga', 'paid'].includes(status)) return null;

    try {
      await syncManualPaymentToAsaas(context.params.uid, snap.ref, data);
    } catch (err) {
      logger.error('onInvoiceCreatedPaid error:', context.params.uid, context.params.invoiceId, err.message);
    }

    return null;
  });

/* =======================================================================
   getAsaasPaymentLink — retorna o link de pagamento da fatura aberta do associado
   ======================================================================= */
exports.getAsaasPaymentLink = functions.https.onCall(async (data, context) => {
  const member = await auth.requireOrganizationMember(context);
  const userSnap = await db.collection('users').doc(member.uid).get();
  const user = userSnap.data();
  if (!user.asaasSubscriptionId)
    throw new functions.https.HttpsError('not-found', 'Assinatura não configurada. Entre em contato com o clube.');

  const provider = await getProviderForOrg(member.orgId);

  for (const st of ['PENDING', 'OVERDUE']) {
    const charges = await provider.listCharges({ subscriptionId: user.asaasSubscriptionId, status: st, limit: 1, sort: 'dueDate', order: 'asc' });
    if (charges.length) {
      const p = charges[0];
      return { invoiceUrl: p.invoiceUrl, asaasPaymentId: p.providerId, dueDate: p.dueDate, value: p.value, status: p.rawStatus };
    }
  }

  return { emDia: true };
});

/* =======================================================================
   Auto-cancelamento e reativação de assinatura pelo próprio associado
   ======================================================================= */

// Envia um e-mail curto de aviso aos admins da ORGANIZAÇÃO do associado (campo
// opcional `organizations/{orgId}.notificationEmails`; sem ele, cai no mesmo
// fallback global de sempre — retrocompatível com o CCBMG). Nunca lança — falha
// de e-mail não pode impedir o cancelamento/reativação em si.
async function notifyAdminsByEmail(orgId, subject, bodyHtml) {
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  const send = (async () => {
    try {
      const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');
      const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPassword },
      });

      const org = orgId ? await organizationResolver.getOrganization(orgId) : null;
      const to = Array.isArray(org?.notificationEmails) && org.notificationEmails.length
        ? org.notificationEmails.join(', ')
        : 'waldiney.serafim@gmail.com, mpmarquesnutri@gmail.com';

      await transporter.sendMail({
        from: '"Clube do Cavalo Bonfim MG" <contato@clubedocavalobonfim.com.br>',
        to,
        subject,
        html: bodyHtml,
      });
    } catch (err) {
      console.warn('notifyAdminsByEmail: falha ao enviar e-mail:', err.message);
    }
  })();
  await Promise.race([send, timeout]);
}

// Callable: o próprio associado cancela a assinatura, após confirmar CPF e telefone.
//
// Importante: NÃO grava ativo:false — ver comentário histórico completo em
// docs/FASE2_CLOUD_FUNCTIONS_AUDIT.md / CLAUDE.md ("Autocancelamento pelo associado").
exports.cancelMySubscription = functions.https.onCall(async (data, context) => {
  const member = await auth.requireOrganizationMember(context);
  const userRef = db.collection('users').doc(member.uid);
  const userData = member.userDoc;

  const cpfInput  = String(data?.cpf || '').replace(/\D/g, '');
  const telInput  = String(data?.telefone || '').replace(/\D/g, '');
  const cpfStored = String(userData.cpf || '').replace(/\D/g, '');
  const telStored = String(userData.telefone || '').replace(/\D/g, '');
  if (!cpfInput || !telInput || cpfInput !== cpfStored || telInput !== telStored) {
    throw new functions.https.HttpsError('permission-denied', 'CPF ou telefone não conferem com o cadastro.');
  }

  if (userData.ativo === false) {
    throw new functions.https.HttpsError('failed-precondition', 'Sua conta está desativada pela administração. Entre em contato com o clube.');
  }
  if (userData.assinaturaCanceladaPeloAssociado === true) {
    throw new functions.https.HttpsError('failed-precondition', 'Sua assinatura já está cancelada.');
  }

  try {
    const provider = await getProviderForOrg(member.orgId);

    if (userData.asaasSubscriptionId) {
      await provider.cancelSubscription(userData.asaasSubscriptionId);
    }
    if (userData.asaasId) {
      await cancelOpenPayments(provider, member.uid, userData.asaasId);
      await provider.notifications.setEnabled(userData.asaasId, false);
    }
  } catch (err) {
    logger.error('cancelMySubscription: falha ao cancelar no provider', member.uid, err.message);
    throw new functions.https.HttpsError('internal', 'Não foi possível cancelar sua assinatura agora. Tente novamente ou contate o clube.');
  }

  await userRef.update({
    assinaturaCanceladaEm: admin.firestore.FieldValue.serverTimestamp(),
    assinaturaCanceladaPeloAssociado: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let activeUntilStr = '—';
  try {
    await updateFinanceSummary(member.uid);
    const summarySnap = await userRef.collection('finance').doc('summary').get();
    const activeUntil = summarySnap.exists ? summarySnap.data().activeUntil : null;
    if (activeUntil) activeUntilStr = formatDateBR(activeUntil.toDate ? activeUntil.toDate() : new Date(activeUntil));
  } catch (_) { /* opcional */ }

  await notifyAdminsByEmail(
    member.orgId,
    `CCBMG - Associado cancelou a própria assinatura: ${userData.nome || member.uid}`,
    `<p>O associado <strong>${escHtml(userData.nome || '—')}</strong> (CPF ${escHtml(userData.cpf || '—')}, tel. ${escHtml(userData.telefone || '—')}) cancelou a própria assinatura pelo portal.</p>
     <p>Plano: ${escHtml(userData.planType || '—')}<br>Acesso garantido até: ${escHtml(activeUntilStr)}</p>`
  );

  console.log(`cancelMySubscription: uid=${member.uid} cancelado pelo próprio associado`);
  return { success: true, activeUntil: activeUntilStr };
});

// Callable: o próprio associado reativa uma assinatura que ele mesmo cancelou.
exports.reactivateMySubscription = functions.https.onCall(async (data, context) => {
  const member = await auth.requireOrganizationMember(context);
  const userRef = db.collection('users').doc(member.uid);
  const userData = member.userDoc;

  if (userData.ativo === false) {
    throw new functions.https.HttpsError('permission-denied', 'Sua conta foi desativada pela administração. Entre em contato com o clube para reativar.');
  }
  if (userData.assinaturaCanceladaPeloAssociado !== true) {
    throw new functions.https.HttpsError('failed-precondition', 'Não há cancelamento para reverter — sua assinatura já está ativa.');
  }

  try {
    const provider = await getProviderForOrg(member.orgId);

    if (userData.asaasSubscriptionId) {
      await provider.updateSubscriptionStatus(userData.asaasSubscriptionId, 'ACTIVE');
    }
    if (userData.asaasId) {
      await provider.notifications.sync(userData.asaasId);
      await createImmediateChargeOnReactivation(provider, member.uid, userData);
    }
  } catch (err) {
    logger.error('reactivateMySubscription: falha ao reativar no provider', member.uid, err.message);
    throw new functions.https.HttpsError('internal', 'Não foi possível reativar sua assinatura agora. Tente novamente ou contate o clube.');
  }

  await userRef.update({
    assinaturaCanceladaEm: admin.firestore.FieldValue.delete(),
    assinaturaCanceladaPeloAssociado: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try { await updateFinanceSummary(member.uid); } catch (_) { /* opcional */ }

  await notifyAdminsByEmail(
    member.orgId,
    `CCBMG - Associado reativou a própria assinatura: ${userData.nome || member.uid}`,
    `<p>O associado <strong>${escHtml(userData.nome || '—')}</strong> (CPF ${escHtml(userData.cpf || '—')}) reativou a própria assinatura pelo portal.</p>`
  );

  console.log(`reactivateMySubscription: uid=${member.uid} reativado pelo próprio associado`);
  return { success: true };
});

/* =======================================================================
   CENTRAL FINANCEIRA — sincronização sob demanda + ações rápidas do painel admin
   ======================================================================= */

// Busca assinatura + pagamentos recentes ao vivo no provider, reconcilia
// financeInvoices/finance/summary e grava o resultado em asaasSync. Usado tanto
// pela callable interativa (manual=true) quanto pela reconciliação diária
// (manual=false) — única fonte dessa rotina para as duas não divergirem.
async function syncOneAssociado(provider, uid, { manual = false } = {}) {
  const userRef = db.collection('users').doc(uid);

  try {
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error('Associado não encontrado.');
    const userData = userSnap.data();
    if (!userData.asaasId || !userData.asaasSubscriptionId) {
      throw new Error('Associado sem assinatura Asaas configurada.');
    }

    const { subscription, recentPayments, notifications } = await provider.synchronize({
      customerId: userData.asaasId,
      subscriptionId: userData.asaasSubscriptionId,
    });
    if (!subscription) throw new Error('Assinatura não encontrada no provider.');

    // Reconcilia só os pagamentos já efetivamente recebidos — mesmo escopo do
    // webhook, nunca mexe em cobranças pendentes/vencidas (responsabilidade do provider).
    for (const p of recentPayments) {
      if (p.status === 'pago') await upsertInvoiceFromAsaasPayment(uid, p);
    }

    await updateFinanceSummary(uid);

    // Estado da automação de notificações POR CANAL — alimenta o indicador na Central
    // de Associados. Best-effort: se a leitura falhar, não interrompe a sincronização.
    let notifSummary = null;
    try {
      const whatsApplicable = notifications.filter(n => n.event !== 'SEND_LINHA_DIGITAVEL');
      notifSummary = {
        configured: notifications.length > 0,
        whatsapp:   whatsApplicable.length > 0 && whatsApplicable.every(n => n.whatsappEnabledForCustomer === true),
        sms:        notifications.length > 0 && notifications.every(n => n.smsEnabledForCustomer === true),
        email:      notifications.length > 0 && notifications.every(n => n.emailEnabledForCustomer === true),
        checkedAt:  admin.firestore.FieldValue.serverTimestamp(),
      };
    } catch (e) {
      console.warn('syncOneAssociado: falha ao ler notificações', uid, e.message);
    }

    await userRef.collection('finance').doc('summary').set({
      subscriptionStatus:      subscription.status || null,
      subscriptionValue:       subscription.value ?? null,
      subscriptionCycle:       subscription.cycle || null,
      subscriptionBillingType: subscription.billingType || null,
      subscriptionNextDueDate: subscription.nextDueDate || null,
      ...(notifSummary ? { notif: notifSummary } : {}),
    }, { merge: true });

    const nowTs = admin.firestore.FieldValue.serverTimestamp();
    const syncPatch = {
      'asaasSync.lastSyncedAt':   nowTs,
      'asaasSync.lastSyncResult': 'ok',
      'asaasSync.lastSyncError':  null,
    };
    if (manual) {
      syncPatch['asaasSync.lastApiCheckAt']     = nowTs;
      syncPatch['asaasSync.lastApiCheckStatus'] = 'ok';
    }
    await userRef.update(syncPatch);

    return { ok: true };
  } catch (err) {
    const nowTs = admin.firestore.FieldValue.serverTimestamp();
    const syncPatch = {
      'asaasSync.lastSyncedAt':   nowTs,
      'asaasSync.lastSyncResult': 'error',
      'asaasSync.lastSyncError':  err.message,
    };
    if (manual) {
      syncPatch['asaasSync.lastApiCheckAt']     = nowTs;
      syncPatch['asaasSync.lastApiCheckStatus'] = 'error';
    }
    await userRef.update(syncPatch).catch(() => {});
    throw err;
  }
}

// Callable: "Atualizar dados" no painel — consulta o provider ao vivo para 1 associado
// DA MESMA ORGANIZAÇÃO do chamador.
exports.asaasSyncAssociado = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationAdmin(context);
  const target = await auth.assertCallerCanManageTarget(caller, data?.uid);

  try {
    const provider = await getProviderForOrg(caller.orgId);
    await syncOneAssociado(provider, data.uid, { manual: true });
  } catch (err) {
    throw new functions.https.HttpsError('internal', err.message || 'Falha ao consultar o provider.');
  }

  const summarySnap = await db.collection('users').doc(data.uid).collection('finance').doc('summary').get();
  return { ok: true, summary: summarySnap.exists ? summarySnap.data() : null };
});

// Callable: "Gerar cobrança" no painel — cria uma cobrança avulsa para associado DA MESMA ORGANIZAÇÃO.
exports.asaasCreatePayment = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationAdmin(context);
  const target = await auth.assertCallerCanManageTarget(caller, data?.uid);

  const value = Number(data?.value);
  const description = String(data?.description || '').trim();
  if (!value || value <= 0) throw new functions.https.HttpsError('invalid-argument', 'Valor inválido.');
  if (!target.userDoc.asaasId) throw new functions.https.HttpsError('failed-precondition', 'Associado sem cadastro no provider.');

  const provider = await getProviderForOrg(caller.orgId);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 5);

  const { providerId, raw } = await provider.createCharge({
    customerId: target.userDoc.asaasId,
    value,
    dueDate: dueDate.toISOString().slice(0, 10),
    description: description || 'Cobrança avulsa CCBMG',
    externalReference: data.uid,
  });

  await writeOrgAuditLog('cobranca_avulsa_criada', { uid: data.uid, asaasPaymentId: providerId, value }, context, caller.orgId);
  console.log(`asaasCreatePayment: uid=${data.uid} payment=${providerId} value=${value}`);
  return { asaasPaymentId: providerId, invoiceUrl: raw.invoiceUrl, dueDate: raw.dueDate };
});

// Callable: "Cancelar cobrança" no painel, para associado DA MESMA ORGANIZAÇÃO.
exports.asaasCancelPayment = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationAdmin(context);
  await auth.assertCallerCanManageTarget(caller, data?.uid);

  const asaasPaymentId = data?.asaasPaymentId;
  if (!asaasPaymentId) {
    throw new functions.https.HttpsError('invalid-argument', 'asaasPaymentId é obrigatório.');
  }

  // Patch de segurança (Fase 3.6): confirma posse ANTES de cancelar no
  // provider — antes, qualquer asaasPaymentId de QUALQUER organização era
  // aceito, porque todas dividem a mesma conta Asaas.
  const invDoc = await assertPaymentBelongsToUid(data.uid, asaasPaymentId);

  const provider = await getProviderForOrg(caller.orgId);
  const { deleted } = await provider.cancelCharge(asaasPaymentId);
  if (!deleted) {
    throw new functions.https.HttpsError('internal', 'Falha ao cancelar cobrança no provider.');
  }

  await invDoc.ref.update({
    status: 'cancelado',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeOrgAuditLog('cobranca_cancelada', { uid: data.uid, asaasPaymentId }, context, caller.orgId);
  console.log(`asaasCancelPayment: uid=${data.uid} payment=${asaasPaymentId} cancelado`);
  return { ok: true };
});

// Callable: "Consultar cobrança" no painel — status ao vivo, somente leitura.
exports.asaasGetPaymentStatus = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationAdmin(context);
  await auth.assertCallerCanManageTarget(caller, data?.uid);

  const asaasPaymentId = data?.asaasPaymentId;
  if (!asaasPaymentId) throw new functions.https.HttpsError('invalid-argument', 'asaasPaymentId é obrigatório.');

  // Patch de segurança (Fase 3.6): mesma checagem de posse de asaasCancelPayment
  // — sem isso, um admin de qualquer organização podia consultar o status de
  // uma cobrança de outra organização só sabendo o ID.
  await assertPaymentBelongsToUid(data.uid, asaasPaymentId);

  const provider = await getProviderForOrg(caller.orgId);
  const payment = await provider.getCharge(asaasPaymentId);

  return {
    status: payment.rawStatus,
    value: payment.value,
    dueDate: payment.dueDate,
    paymentDate: payment.paymentDate,
    billingType: payment.billingType,
    invoiceUrl: payment.invoiceUrl,
    invoiceNumber: payment.invoiceNumber,
  };
});

// Agendada: reconciliação diária de madrugada — autocorrige o Firestore caso algum
// webhook tenha falhado. Percorre organização por organização (isolamento) e, dentro
// de cada uma, só os associados dela — antes desta fase, lia `users` inteiro de uma vez.
exports.asaasReconciliationDaily = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .pubsub.schedule('0 4 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const orgsSnap = await db.collection('organizations').get();
    const orgs = orgsSnap.empty
      ? [{ id: 'org_bonfim' }]
      : orgsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.ativo !== false);

    const results = { synced: 0, errors: [] };

    for (const org of orgs) {
      let provider;
      try {
        provider = await getProviderForOrg(org.id);
      } catch (err) {
        logger.error('asaasReconciliationDaily: falha ao resolver provider da organização', org.id, err.message);
        continue; // 1 organização com provider quebrado não impede as demais
      }

      const usersSnap = await db.collection('users').where('orgId', '==', org.id).get();

      for (const userDoc of usersSnap.docs) {
        const userData = userDoc.data();
        if (!userData.asaasId || !userData.asaasSubscriptionId || userData.ativo === false) continue;

        try {
          await syncOneAssociado(provider, userDoc.id, { manual: false });
          results.synced++;
        } catch (err) {
          logger.error('asaasReconciliationDaily error:', org.id, userDoc.id, err.message);
          results.errors.push({ orgId: org.id, uid: userDoc.id, error: err.message });
        }

        await new Promise(r => setTimeout(r, 250));
      }
    }

    console.log('asaasReconciliationDaily result:', results);
    return null;
  });

/* =======================================================================
   WEBHOOK ASAAS → FIREBASE
   Configurar no Asaas: Configurações → Integrações → Webhook
   URL: https://us-central1-clubecavalobonfim.cloudfunctions.net/asaasWebhook

   Fase 3.7 (Sandbox multi-tenant) — extraído para handleAsaasWebhookRequest()
   reutilizável por asaasWebhook (conta Asaas Production, CCBMG e demais
   tenants) e asaasSandboxWebhook (conta Asaas Sandbox, tenant Sandbox
   oficial da plataforma). O Asaas só suporta 1 webhook configurado por CONTA
   — não há orgId no payload antes de resolver o provider — por isso são 2
   endpoints/tokens distintos, não roteamento em tempo de requisição (mesmo
   padrão já usado por auctionAsaasWebhook).
   ======================================================================= */
async function handleAsaasWebhookRequest(req, res, { tokenSecretName, resolveProvider }) {
  try {
    const expectedToken = await getSecret(tokenSecretName);
    const receivedToken = req.headers['asaas-access-token'];
    if (!receivedToken || receivedToken !== expectedToken) {
      logger.warn('asaasWebhook: token inválido ou ausente');
      return res.status(401).send('Unauthorized');
    }
  } catch (err) {
    logger.error('asaasWebhook: erro ao validar token', err.message);
    return res.status(500).send('Error');
  }

  const { event, payment } = req.body || {};

  try {
    const provider = await resolveProvider();
    const result = await provider.processWebhook({ event, payment });
    if (!result.confirmed) return res.status(200).send('OK');

    const uid = result.subscriptionExternalReference;
    if (!uid) {
      logger.warn('asaasWebhook: assinatura sem externalReference', payment.subscription);
      return res.status(200).send('OK');
    }

    await db.collection('users').doc(uid).update({
      'asaasSync.lastWebhookAt':    admin.firestore.FieldValue.serverTimestamp(),
      'asaasSync.lastWebhookEvent': event,
    }).catch(err => logger.warn('asaasWebhook: falha ao gravar asaasSync', uid, err.message));

    const upsertResult = await upsertInvoiceFromAsaasPayment(uid, result.payment);

    if (upsertResult.action === 'skipped') {
      logger.warn('asaasWebhook:', upsertResult.reason, uid);
      return res.status(200).send('OK');
    }
    console.log(`asaasWebhook: fatura ${upsertResult.action} uid=${uid} invoiceId=${upsertResult.invoiceId} payment=${payment.id}`);

    await updateFinanceSummary(uid);

    return res.status(200).send('OK');
  } catch (err) {
    logger.error('asaasWebhook error:', err.message);
    return res.status(500).send('Error');
  }
}

exports.asaasWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  return handleAsaasWebhookRequest(req, res, {
    tokenSecretName: ASAAS_WEBHOOK_TOKEN,
    resolveProvider: getDefaultProvider,
  });
});

/* =======================================================================
   WEBHOOK ASAAS SANDBOX → FIREBASE
   Configurar na conta Asaas SANDBOX (sandbox.asaas.com): Configurações →
   Integrações → Webhook. Usa token e conta Asaas próprios (asaas-sandbox-*
   no Secret Manager) — nunca a conta de produção do CCBMG.
   URL: https://us-central1-clubecavalobonfim.cloudfunctions.net/asaasSandboxWebhook
   ======================================================================= */
exports.asaasSandboxWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  return handleAsaasWebhookRequest(req, res, {
    tokenSecretName: ASAAS_SANDBOX_WEBHOOK_TOKEN,
    resolveProvider: () => getBillingProvider({
      org: { billingEnvironment: 'sandbox' },
      getSecret,
      defaultSecretName: ASAAS_SANDBOX_SECRET,
    }),
  });
});

// Redefine a senha de um associado DA MESMA ORGANIZAÇÃO. Requer role master.
exports.resetUserPassword = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationMaster(context);

  const { targetUid, newPassword } = data;
  if (!targetUid || !newPassword || newPassword.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'UID e senha (mínimo 8 caracteres) são obrigatórios.');
  }
  if (targetUid === caller.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Use o formulário de troca de senha para alterar sua própria senha.');
  }

  const target = await auth.assertCallerCanManageTarget(caller, targetUid);
  if (target.userDoc.categoriaAssociado === 'mirim') {
    throw new functions.https.HttpsError('failed-precondition', 'Associado Mirim não tem conta de acesso — não há senha para redefinir.');
  }

  await admin.auth().updateUser(targetUid, { password: newPassword });
  await db.collection('users').doc(targetUid).update({
    primeiroAcesso: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeOrgAuditLog('senha_redefinida_por_master', { uid: targetUid }, context, caller.orgId);
  console.log(`resetUserPassword: senha redefinida para uid=${targetUid} por master uid=${caller.uid}`);
  return { success: true };
});

/* =======================================================================
   Reset de senha self-service via SMS (Firebase Phone Authentication)
   ======================================================================= */

// Limita tentativas de iniciar o fluxo a 5 por CPF por hora — mitiga flood/enumeração.
async function checkAndIncrementResetAttempts(cpfDigits) {
  const ref = db.collection('passwordResetAttempts').doc(cpfDigits);
  const MAX_ATTEMPTS = 5;
  const WINDOW_MS = 60 * 60 * 1000;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const windowStartMs = snap.exists ? (snap.data().windowStart?.toMillis?.() ?? 0) : 0;

    if (!snap.exists || (nowMs - windowStartMs) > WINDOW_MS) {
      tx.set(ref, { count: 1, windowStart: admin.firestore.FieldValue.serverTimestamp() });
      return;
    }
    if (snap.data().count >= MAX_ATTEMPTS) {
      throw new functions.https.HttpsError('resource-exhausted', 'Muitas tentativas para este CPF. Tente novamente mais tarde.');
    }
    tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
  });
}

// Callable: primeiro passo do reset self-service. Não exige autenticação (roda antes
// do login) — por isso não há "organização do chamador" pra comparar.
//
// PATCH DE SEGURANÇA (Auditoria Final RC1, achado P1): antes desta correção,
// qualquer chamada anônima com um CPF válido recebia o telefone COMPLETO de
// volta (necessário pro signInWithPhoneNumber() do cliente — ver análise
// completa no relatório da auditoria) e a busca por CPF era GLOBAL entre
// organizações quando orgId não era informado. Duas mitigações, sem mudar o
// mecanismo de SMS (Firebase Phone Auth client-driven não tem alternativa
// server-side — ver relatório): orgId passou a ser OBRIGATÓRIO (fecha a
// amplificação cross-tenant) e um token de reCAPTCHA Enterprise (independente
// do RecaptchaVerifier do Phone Auth, que não expõe secret nenhum pro nosso
// servidor verificar) passou a ser exigido e verificado antes de qualquer
// busca no Firestore — eleva o custo de automação/enumeração em massa. Não
// elimina 100% o risco pra um ataque manual e direcionado com CPF já
// conhecido — limitação técnica documentada, não um bug não tratado.
const { GoogleAuth } = require('google-auth-library');
const recaptchaAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const RECAPTCHA_SITE_KEY = '6Ld-m38tAAAAAI6Useox6aHfJ6WpxySYIfzl_Qx7';
const RECAPTCHA_MIN_SCORE = 0.5;

async function verifyRecaptchaToken(token, expectedAction) {
  if (!token) {
    throw new functions.https.HttpsError('failed-precondition', 'Verificação de segurança ausente. Recarregue a página e tente novamente.');
  }
  let assessment;
  try {
    const client = await recaptchaAuth.getClient();
    const { token: accessToken } = await client.getAccessToken();
    const resp = await fetch(`https://recaptchaenterprise.googleapis.com/v1/projects/clubecavalobonfim/assessments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { token, siteKey: RECAPTCHA_SITE_KEY, expectedAction } }),
    });
    assessment = await resp.json();
  } catch (e) {
    logger.error('verifyRecaptchaToken: falha ao chamar reCAPTCHA Enterprise', e.message);
    throw new functions.https.HttpsError('internal', 'Não foi possível validar a verificação de segurança. Tente novamente.');
  }
  const valid = assessment?.tokenProperties?.valid;
  const action = assessment?.tokenProperties?.action;
  const score = assessment?.riskAnalysis?.score;
  if (!valid || action !== expectedAction || typeof score !== 'number' || score < RECAPTCHA_MIN_SCORE) {
    logger.warn(`verifyRecaptchaToken: rejeitado (valid=${valid}, action=${action}, score=${score}, invalidReason=${assessment?.tokenProperties?.invalidReason})`);
    throw new functions.https.HttpsError('permission-denied', 'Verificação de segurança falhou. Tente novamente.');
  }
}

exports.startPasswordReset = functions.https.onCall(async (data, context) => {
  const cpfDigits = String(data?.cpf || '').replace(/\D/g, '');
  if (cpfDigits.length !== 11) {
    throw new functions.https.HttpsError('invalid-argument', 'CPF inválido.');
  }
  const orgId = String(data?.orgId || '').trim();
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'orgId é obrigatório.');
  }

  await verifyRecaptchaToken(data?.recaptchaToken, 'start_password_reset');
  await checkAndIncrementResetAttempts(cpfDigits);

  const query = db.collection('users').where('cpf', '==', cpfDigits).where('orgId', '==', orgId);
  const snap = await query.limit(1).get();
  if (snap.empty) {
    throw new functions.https.HttpsError('not-found', 'CPF não encontrado.');
  }
  const userData = snap.docs[0].data();

  if (userData.categoriaAssociado === 'mirim') {
    throw new functions.https.HttpsError('failed-precondition', 'Associado Mirim não possui conta de acesso própria — fale com o responsável.');
  }

  const telDigits = String(userData.telefone || '').replace(/\D/g, '');
  if (!telDigits) {
    throw new functions.https.HttpsError('failed-precondition', 'Não há telefone cadastrado para esta conta. Entre em contato com a secretaria do clube.');
  }

  const telefoneE164 = telDigits.length === 13 && telDigits.startsWith('55')
    ? `+${telDigits}`
    : `+55${telDigits}`;

  return { telefoneE164 };
});

// Callable: segundo/último passo do reset self-service.
exports.completePasswordReset = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Verificação de telefone necessária.');
  }
  const verifiedPhone = context.auth.token.phone_number;
  if (!verifiedPhone) {
    throw new functions.https.HttpsError('failed-precondition', 'Telefone não verificado.');
  }

  const cpfDigits = String(data?.cpf || '').replace(/\D/g, '');
  const newPassword = String(data?.newPassword || '');
  if (cpfDigits.length !== 11 || newPassword.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'CPF e senha (mínimo 8 caracteres) são obrigatórios.');
  }

  let query = db.collection('users').where('cpf', '==', cpfDigits);
  if (data?.orgId) query = query.where('orgId', '==', String(data.orgId));
  const snap = await query.limit(1).get();
  if (snap.empty) {
    throw new functions.https.HttpsError('not-found', 'CPF não encontrado.');
  }
  const targetDoc = snap.docs[0];
  const targetUid = targetDoc.id;
  const userData = targetDoc.data();

  const telStored = String(userData.telefone || '').replace(/\D/g, '');
  const telVerified = verifiedPhone.replace(/\D/g, '').replace(/^55/, '');
  if (!telStored || telStored !== telVerified) {
    throw new functions.https.HttpsError('permission-denied', 'Telefone verificado não confere com o cadastro.');
  }

  await admin.auth().updateUser(targetUid, { password: newPassword });
  await db.collection('users').doc(targetUid).update({
    primeiroAcesso: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await admin.auth().deleteUser(context.auth.uid).catch((err) =>
    console.warn('completePasswordReset: falha ao limpar uid temporário de telefone:', err.message));

  await notifyAdminsByEmail(
    userData.orgId,
    `CCBMG - Senha redefinida via SMS: ${userData.nome || targetUid}`,
    `<p>O associado <strong>${escHtml(userData.nome || '—')}</strong> (CPF ${escHtml(userData.cpf || '—')}) redefiniu a própria senha via verificação por SMS.</p>`
  );

  console.log(`completePasswordReset: uid=${targetUid} senha redefinida via SMS`);
  return { success: true };
});

// Exclui definitivamente um associado DA MESMA ORGANIZAÇÃO: cobrança/cliente no
// provider, subcoleções do Firestore, o documento em users/{uid} e a conta no
// Firebase Auth. Irreversível — restrito ao perfil master.
exports.deleteAssociado = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationMaster(context);

  const targetUid = data?.uid;
  if (targetUid === caller.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Não é possível excluir a própria conta por esta rota.');
  }

  const target = await auth.assertCallerCanManageTarget(caller, targetUid);
  const userData = target.userDoc;
  const userRef = db.collection('users').doc(targetUid);

  // Cancela cliente/assinatura no provider antes de apagar o registro local (não bloqueia a exclusão em caso de falha)
  try {
    const provider = await getProviderForOrg(caller.orgId);
    if (userData.asaasSubscriptionId) await provider.deleteSubscription(userData.asaasSubscriptionId).catch(() => {});
    // Fase 2C: deleteCustomer() de verdade (Fase 2B deixou isto como um no-op
    // defensivo — provider ainda não expunha exclusão de cliente).
    if (userData.asaasId) await provider.deleteCustomer(userData.asaasId).catch(() => {});
  } catch (e) {
    console.warn(`deleteAssociado: falha ao remover uid=${targetUid} do provider (prosseguindo com exclusão local): ${e.message}`);
  }

  const invSnap = await userRef.collection('financeInvoices').get();
  const batch = db.batch();
  invSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(userRef.collection('finance').doc('summary'));
  batch.delete(userRef);
  await batch.commit();

  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      throw new functions.https.HttpsError('internal', `Registro do Firestore removido, mas falhou ao excluir conta de autenticação: ${e.message}`);
    }
  }

  await writeOrgAuditLog('associado_excluido', { uid: targetUid, nome: userData.nome || null, cpf: userData.cpf || null }, context, caller.orgId);
  console.log(`deleteAssociado: uid=${targetUid} excluído por master uid=${caller.uid}`);
  return { success: true };
});


/* ================================================================
   MÓDULO DE LEILÕES
   Fase 2C: schema ganhou orgId de verdade. auctionLots já vinha recebendo
   orgId do frontend desde jun/2026 (lote_form.html, commit 97a498ab) e
   admin_leiloes.html já consultava auctionLots/auctionSales filtrando por
   orgId — mas as Cloud Functions que CRIAM auctionSales/auctionPayments
   nunca escreviam esse campo, e nenhuma delas validava organização na
   autorização. Esta seção fecha essa lacuna (ver relatório da Fase 2C para
   o achado completo e o backfill).
   ================================================================ */

// ---- placeBid (onCall) ----
exports.placeBid = functions.https.onCall(async (data, context) => {
  const bidder = await auth.requireOrganizationMember(context);

  const { lotId, amount } = data;
  if (!lotId || typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Dados inválidos.');
  }

  const bidderUid  = bidder.uid;
  const lotRef     = db.collection('auctionLots').doc(lotId);
  const bidsRef    = lotRef.collection('bids');

  if (bidder.userDoc.inadimplenteLeilao === true) {
    throw new functions.https.HttpsError('permission-denied', 'Sua conta está bloqueada por inadimplência.');
  }

  const result = await db.runTransaction(async (tx) => {
    const lotSnap = await tx.get(lotRef);
    if (!lotSnap.exists) throw new functions.https.HttpsError('not-found', 'Lote não encontrado.');

    const lot = lotSnap.data();

    auth.assertSameOrganization(bidder.orgId, lot.orgId, 'Este lote pertence a outra organização.');

    if (lot.status !== 'publicado') {
      throw new functions.https.HttpsError('failed-precondition', 'Este lote não está ativo.');
    }

    const nowMs  = Date.now();
    const endMs   = lot.endTime?.toMillis?.() ?? 0;
    if (endMs && nowMs > endMs) {
      throw new functions.https.HttpsError('failed-precondition', 'O leilão deste lote já encerrou.');
    }

    if (lot.sellerUid === bidderUid) {
      throw new functions.https.HttpsError('permission-denied', 'Você não pode dar lances em seu próprio lote.');
    }

    const base    = (lot.lastBid && lot.lastBid > 0) ? lot.lastBid : lot.initialBid;
    const minBid  = Math.ceil(base * 1.02 * 100) / 100;
    if (amount < minBid) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `Lance mínimo: R$ ${minBid.toFixed(2).replace('.',',')}. Valor informado: R$ ${amount.toFixed(2).replace('.',',')}.`
      );
    }

    let newEndTime = lot.endTime;
    if (endMs && (endMs - nowMs) < 120000) {
      newEndTime = new admin.firestore.Timestamp.fromMillis(nowMs + 120000);
    }

    const bidId  = bidsRef.doc().id;
    const bidDoc = { bidderUid, amount, placedAt: admin.firestore.FieldValue.serverTimestamp() };

    tx.set(bidsRef.doc(bidId), bidDoc);
    tx.update(lotRef, {
      lastBid:      amount,
      lastBidderUid: bidderUid,
      bidCount:     admin.firestore.FieldValue.increment(1),
      endTime:      newEndTime,
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    return { bidId, newEndTime: newEndTime?.toMillis?.() ?? endMs };
  });

  return result;
});

// ---- encerrarLotesExpirados (scheduled, a cada minuto) ----
exports.encerrarLotesExpirados = functions.pubsub.schedule('every 1 minutes')
  .onRun(async () => {
    const nowTs = admin.firestore.Timestamp.now();
    const snap = await db.collection('auctionLots')
      .where('status', '==', 'publicado')
      .where('endTime', '<=', nowTs)
      .get();

    if (snap.empty) return null;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { status: 'encerrado', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await batch.commit();

    for (const doc of snap.docs) {
      const lot = doc.data();
      if (!lot.lastBid || !lot.lastBidderUid) continue;

      const existingSale = await db.collection('auctionSales').where('lotId', '==', doc.id).limit(1).get();
      if (!existingSale.empty) continue;

      const finalAmount       = lot.lastBid;
      const commissionClube   = Math.round(finalAmount * 0.05 * 100) / 100;
      const commissionSistema = Math.round(finalAmount * 0.05 * 100) / 100;
      const commissionTotal   = Math.round((commissionClube + commissionSistema) * 100) / 100;
      const netSeller         = Math.round((finalAmount - commissionTotal) * 100) / 100;

      const buyerSnap  = await db.collection('users').doc(lot.lastBidderUid).get();
      const sellerSnap = await db.collection('users').doc(lot.sellerUid).get();

      await db.collection('auctionSales').add({
        orgId:              lot.orgId,
        lotId:              doc.id,
        lotTitle:           lot.title || '',
        sellerUid:          lot.sellerUid,
        sellerEmail:        sellerSnap.exists ? (sellerSnap.data().email || '') : '',
        sellerName:         sellerSnap.exists ? (sellerSnap.data().nome  || '') : '',
        buyerUid:           lot.lastBidderUid,
        buyerEmail:         buyerSnap.exists  ? (buyerSnap.data().email  || '') : '',
        buyerName:          buyerSnap.exists  ? (buyerSnap.data().nome   || '') : '',
        finalAmount,
        commissionClube,
        commissionSistema,
        commissionTotal,
        netSeller,
        status:             'aguardando_pagamento',
        createdAt:          admin.firestore.FieldValue.serverTimestamp(),
      });

      const batch2 = db.batch();
      const notifRef = db.collection('auctionNotifications');
      batch2.set(notifRef.doc(), {
        orgId: lot.orgId,
        recipientUid: lot.lastBidderUid,
        type: 'lote_arrematado',
        lotId: doc.id,
        lotTitle: lot.title || '',
        message: `Parabéns! Você arrematou o lote "${lot.title}" por R$ ${finalAmount.toFixed(2).replace('.',',')}. Efetue o pagamento em até 5 dias.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch2.set(notifRef.doc(), {
        orgId: lot.orgId,
        recipientUid: lot.sellerUid,
        type: 'lote_vendido',
        lotId: doc.id,
        lotTitle: lot.title || '',
        message: `Seu lote "${lot.title}" foi arrematado por R$ ${finalAmount.toFixed(2).replace('.',',')}. Aguardando pagamento do comprador.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch2.commit();
    }

    console.log(`encerrarLotesExpirados: ${snap.size} lotes encerrados`);
    return null;
  });

// ---- gerarCobrancaLeilao (onCall) ----
exports.gerarCobrancaLeilao = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationMember(context);

  const { saleId } = data;
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'saleId obrigatório.');

  const saleSnap = await db.collection('auctionSales').doc(saleId).get();
  if (!saleSnap.exists) throw new functions.https.HttpsError('not-found', 'Venda não encontrada.');

  const sale = saleSnap.data();

  // Vendas criadas antes da Fase 2C podem não ter orgId ainda (ver backfillLeilaoOrgId) —
  // nesse caso só admin/master decide (não dá pra confirmar "mesma organização").
  if (sale.orgId) {
    auth.assertSameOrganization(caller.orgId, sale.orgId, 'Esta venda pertence a outra organização.');
  }

  const isAdmin = ['admin', 'master'].includes(caller.role);
  const isParty = caller.uid === sale.sellerUid || caller.uid === sale.buyerUid;
  if (!isAdmin && !isParty) {
    throw new functions.https.HttpsError('permission-denied', 'Sem permissão para esta operação.');
  }

  if (sale.status !== 'aguardando_pagamento') {
    throw new functions.https.HttpsError('failed-precondition', 'Esta venda não está aguardando pagamento.');
  }

  const existPay = await db.collection('auctionPayments').where('saleId', '==', saleId).limit(1).get();
  if (!existPay.empty) return { paymentId: existPay.docs[0].id, alreadyExists: true };

  const provider = sale.orgId ? await getProviderForOrg(sale.orgId) : await getDefaultProvider();
  const buyerSnap = await db.collection('users').doc(sale.buyerUid).get();
  const buyer = buyerSnap.exists ? buyerSnap.data() : {};

  let asaasCustomerId = buyer.asaasId;
  if (!asaasCustomerId) {
    const { providerId } = await provider.createCustomer({
      name:              buyer.nome || buyer.email || 'Comprador',
      cpfCnpj:           (buyer.cpf || '').replace(/\D/g,''),
      email:             buyer.email || undefined,
      mobilePhone:       formatPhoneForAsaas(buyer.telefone),
      externalReference: sale.buyerUid,
    });
    asaasCustomerId = providerId;
    await db.collection('users').doc(sale.buyerUid).update({
      asaasId: asaasCustomerId,
      asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 5);

  const { providerId: paymentId, raw } = await provider.createCharge({
    customerId:  asaasCustomerId,
    value:       sale.finalAmount,
    dueDate:     dueDate.toISOString().split('T')[0],
    description: `Arrematação lote: ${sale.lotTitle}`,
    externalReference: saleId,
  });

  const paymentRef = await db.collection('auctionPayments').add({
    orgId:          sale.orgId || null,
    saleId,
    buyerUid:       sale.buyerUid,
    lotId:          sale.lotId,
    lotTitle:       sale.lotTitle,
    amount:         sale.finalAmount,
    asaasPaymentId: paymentId,
    asaasInvoiceUrl: raw.invoiceUrl || null,
    status:         'pendente',
    dueDate:        admin.firestore.Timestamp.fromDate(dueDate),
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  return { paymentId: paymentRef.id, invoiceUrl: raw.invoiceUrl };
});

// ---- auctionAsaasWebhook (HTTP público) ----
exports.auctionAsaasWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const webhookToken = await getSecret(ASAAS_AUCTION_WEBHOOK_TOKEN);
  const incomingToken = req.headers['asaas-access-token'];
  if (!incomingToken || incomingToken !== webhookToken) {
    console.warn('auctionAsaasWebhook: token inválido');
    res.status(401).send('Unauthorized');
    return;
  }

  const event   = req.body;
  const payment = event?.payment;
  if (!payment || !['PAYMENT_RECEIVED','PAYMENT_CONFIRMED'].includes(event.event)) {
    res.status(200).send('ok');
    return;
  }

  // Verificação anti-fraude via provider default: igual ao webhook principal
  // (asaasWebhook), o Asaas manda o webhook pra 1 conta/token só — ainda não há
  // como rotear por organização ANTES de saber a qual venda o payment pertence.
  const provider = await getDefaultProvider();
  const verified = await provider.getCharge(payment.id);
  if (verified.status !== 'pago') {
    console.warn('auctionAsaasWebhook: pagamento não confirmado na API', verified.rawStatus);
    res.status(200).send('ok');
    return;
  }

  const saleId = verified.externalReference;
  if (!saleId) { res.status(200).send('ok'); return; }

  const saleSnapForOrg = await db.collection('auctionSales').doc(saleId).get();
  const saleOrgId = saleSnapForOrg.exists ? (saleSnapForOrg.data().orgId || null) : null;

  const existSnap = await db.collection('auctionPayments').where('asaasPaymentId', '==', payment.id).limit(1).get();

  if (!existSnap.empty) {
    const payDoc = existSnap.docs[0];
    if (payDoc.data().status === 'pago') { res.status(200).send('ok'); return; }
    await payDoc.ref.update({ status: 'pago', paidAt: admin.firestore.FieldValue.serverTimestamp() });
  } else {
    await db.collection('auctionPayments').add({
      orgId:          saleOrgId,
      saleId,
      asaasPaymentId: payment.id,
      amount:         verified.value,
      status:         'pago',
      paidAt:         admin.firestore.FieldValue.serverTimestamp(),
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const saleRef = db.collection('auctionSales').doc(saleId);
  await saleRef.update({
    status:    'pago',
    paidAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`auctionAsaasWebhook: saleId=${saleId} marcado como pago`);
  res.status(200).send('ok');
});

// ---- liberarRepasse (onCall, admin only) ----
exports.liberarRepasse = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationAdmin(context);

  const { saleId } = data;
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'saleId obrigatório.');

  const saleSnap = await db.collection('auctionSales').doc(saleId).get();
  if (!saleSnap.exists) throw new functions.https.HttpsError('not-found', 'Venda não encontrada.');

  const sale = saleSnap.data();

  // Vendas anteriores à Fase 2C podem não ter orgId — só master (cross-org por
  // definição) consegue liberar repasse dessas; admin comum precisa da mesma org.
  if (sale.orgId) {
    auth.assertSameOrganization(caller.orgId, sale.orgId, 'Esta venda pertence a outra organização.');
  } else if (caller.role !== 'master') {
    throw new functions.https.HttpsError('failed-precondition', 'Venda sem organização definida — só o perfil master pode liberar este repasse (ver backfillLeilaoOrgId).');
  }

  if (sale.status !== 'pago') {
    throw new functions.https.HttpsError('failed-precondition', 'Repasse só pode ser liberado após o pagamento.');
  }

  await db.collection('auctionSales').doc(saleId).update({
    status:      'repasse_liberado',
    releasedBy:  caller.uid,
    releasedAt:  admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('auctionNotifications').add({
    orgId:        sale.orgId || null,
    recipientUid: sale.sellerUid,
    type:         'repasse_liberado',
    lotId:        sale.lotId,
    lotTitle:     sale.lotTitle,
    message:      `O repasse de R$ ${(sale.netSeller||0).toFixed(2).replace('.',',')} referente ao lote "${sale.lotTitle}" foi liberado. Entre em contato com o clube para receber.`,
    read:         false,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

// ---- onSaleCreated (Firestore trigger) ----
exports.onSaleCreated = functions.firestore
  .document('auctionSales/{saleId}')
  .onCreate(async (snap) => {
    const sale = snap.data();
    if (!sale.buyerUid) return null;

    const buyerRef  = db.collection('users').doc(sale.buyerUid);
    const buyerSnap = await buyerRef.get();
    if (!buyerSnap.exists) return null;

    const buyer = buyerSnap.data();
    if (buyer.asaasId) return null;

    const provider = sale.orgId ? await getProviderForOrg(sale.orgId) : await getDefaultProvider();
    const { providerId } = await provider.createCustomer({
      name:              buyer.nome || buyer.email || 'Comprador',
      cpfCnpj:           (buyer.cpf || '').replace(/\D/g,''),
      email:             buyer.email || undefined,
      mobilePhone:       formatPhoneForAsaas(buyer.telefone),
      externalReference: sale.buyerUid,
    });

    await buyerRef.update({
      asaasId:       providerId,
      asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`onSaleCreated: cliente Asaas criado para ${sale.buyerUid} → ${providerId}`);
    return null;
  });

// ---- verificarInadimplentesDiarios (scheduled, diário às 09:00 BRT) ----
exports.verificarInadimplentesDiarios = functions.pubsub.schedule('0 9 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const nowTs = admin.firestore.Timestamp.now();
    const snap = await db.collection('auctionPayments')
      .where('status', '==', 'pendente')
      .where('dueDate', '<', nowTs)
      .get();

    if (snap.empty) return null;

    const batch = db.batch();
    const uidsToBlock = new Set();
    const orgIdByUid = new Map();

    for (const doc of snap.docs) {
      const pay = doc.data();
      batch.update(doc.ref, { status: 'vencido', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (pay.buyerUid) {
        uidsToBlock.add(pay.buyerUid);
        if (pay.orgId) orgIdByUid.set(pay.buyerUid, pay.orgId);
      }

      if (pay.saleId) {
        const saleSnap = await db.collection('auctionSales').doc(pay.saleId).get();
        if (saleSnap.exists && saleSnap.data().status === 'aguardando_pagamento') {
          batch.update(saleSnap.ref, { status: 'cancelado', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      }
    }

    await batch.commit();

    for (const uid of uidsToBlock) {
      await db.collection('users').doc(uid).update({
        inadimplenteLeilao: true,
        updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection('auctionNotifications').add({
        orgId:        orgIdByUid.get(uid) || null,
        recipientUid: uid,
        type:         'bloqueio_inadimplencia',
        message:      'Sua conta foi bloqueada para participação em leilões por inadimplência. Entre em contato com o clube para regularizar.',
        read:         false,
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log(`verificarInadimplentesDiarios: ${uidsToBlock.size} usuário(s) bloqueado(s)`);
    return null;
  });

// ---- backfillLeilaoOrgId (onCall, plataforma — uso pontual da Fase 2C) ----
// Preenche `orgId` em documentos de auctionLots/auctionSales/auctionPayments/
// auctionNotifications criados ANTES desta fase (nunca sobrescreve quem já
// tem orgId). auctionLots normalmente já vem preenchido pelo frontend desde
// jun/2026 — o alvo real são auctionSales/auctionPayments/auctionNotifications,
// que só a partir desta fase passaram a ser criados com orgId pelas Cloud
// Functions. Idempotente: rodar de novo não faz nada nos docs já corrigidos.
//
// Fase 3.2: reclassificada de "Organization Master" pra "Platform Administrator"
// — aceita um orgId arbitrário no payload (nunca o do próprio chamador, porque
// quem chama isto não pertence a organização nenhuma), o que sempre foi,
// mecanicamente, uma operação de plataforma, não de autoatendimento de uma
// organização (ver Contexto do plano da Fase 3.2).
exports.backfillLeilaoOrgId = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (data, context) => {
    await platformAuth.requirePlatformAdministrator(context);
    const targetOrgId = data?.orgId;
    if (!targetOrgId) {
      throw new functions.https.HttpsError('invalid-argument', 'Informe orgId.');
    }

    const collections = ['auctionLots', 'auctionSales', 'auctionPayments', 'auctionNotifications'];
    const results = {};

    for (const col of collections) {
      const snap = await db.collection(col).get();
      const missing = snap.docs.filter(d => !d.data().orgId);

      let updated = 0;
      const BATCH_LIMIT = 400; // margem sob o limite de 500 escritas/batch do Firestore
      for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const doc of missing.slice(i, i + BATCH_LIMIT)) {
          batch.update(doc.ref, { orgId: targetOrgId });
          updated++;
        }
        await batch.commit();
      }

      results[col] = { total: snap.size, semOrgId: missing.length, atualizados: updated };
    }

    console.log('backfillLeilaoOrgId result:', targetOrgId, results);
    return { orgId: targetOrgId, results };
  });

/* =========================================================================
   ADMINISTRAÇÃO DA PLATAFORMA (Fase 3.2)
   — CRUD de platformAdmins/{uid} (equipe da Serafim Technologies) + migração
   de uso único das contas "master" antigas. Nenhuma destas functions aceita
   orgId de organização nenhuma — é, por definição, o plano que não tem uma.
   ========================================================================= */

// Toda mutação de platformAdmins é atestada pelo servidor (Admin SDK), nunca
// pelo cliente — platformAdmins/{uid} não permite nenhuma escrita direta via
// Firestore Rules (ver firestore.rules), então este log é a ÚNICA fonte de
// auditoria dessas mutações, ao contrário do logAction() client-side usado
// pelo resto do Painel Master desde a Fase 3.1.
async function writePlatformAuditLog(action, details, context) {
  try {
    await db.collection('systemLogs').add({
      userId: context.auth?.uid || null,
      userEmail: context.auth?.token?.email || null,
      orgId: 'platform',
      action,
      details: details || {},
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writePlatformAuditLog: falha ao gravar auditoria (ignorado):', e.message);
  }
}

// Envia o link de definição de senha por e-mail (nunca transmite senha nenhuma
// em texto puro) — mesmo par de secrets/transporter que notifyAdminsByEmail já
// usa. Nunca lança: falha de e-mail não deve impedir a criação da conta, só é
// reportada de volta pro chamador pra ele repassar o link manualmente.
// Compartilhado entre createPlatformAdmin (Fase 3.2) e provisionOrganization
// (Fase 3.3) — mesmo mecanismo, textos diferentes por contexto.
async function sendAccountInviteEmail(email, nome, resetLink, { subject, introText }) {
  try {
    const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');
    const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPassword } });
    await transporter.sendMail({
      from: '"Portal Associativo — Serafim Technologies" <contato@clubedocavalobonfim.com.br>',
      to: email,
      subject,
      html: `<p>Olá, ${escHtml(nome || '')}.</p>
             <p>${introText}</p>
             <p><a href="${resetLink}">${resetLink}</a></p>`,
    });
    return true;
  } catch (e) {
    console.warn('sendAccountInviteEmail: falha ao enviar e-mail (retornando link pro chamador):', e.message);
    return false;
  }
}

// Callable: cria uma conta de equipe da plataforma (Firebase Auth + platformAdmins/{uid}).
// administrator só cria role:"operator"; owner cria qualquer papel.
exports.createPlatformAdmin = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);

  const email = String(data?.email || '').trim().toLowerCase();
  const nome = String(data?.nome || '').trim();
  const role = data?.role;
  if (!email || !nome || !PLATFORM_ROLES.includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'E-mail, nome e papel (operator/administrator/owner) são obrigatórios.');
  }
  if (caller.role === 'administrator' && role !== 'operator') {
    throw new functions.https.HttpsError('permission-denied', 'Administrator só pode criar contas com papel operator.');
  }

  const { randomBytes } = require('crypto');
  let uid;
  try {
    const userRecord = await admin.auth().createUser({ email, password: randomBytes(24).toString('hex'), displayName: nome });
    uid = userRecord.uid;
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      throw new functions.https.HttpsError('already-exists', 'Já existe uma conta com este e-mail.');
    }
    throw new functions.https.HttpsError('internal', `Falha ao criar conta: ${e.message}`);
  }

  await db.collection('platformAdmins').doc(uid).set({
    role, nome, email, ativo: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: caller.uid,
  });

  // Conta e doc já foram criados nesse ponto — falha daqui em diante nunca deve
  // parecer um erro fatal da operação, só resultar em emailSent:false (o
  // administrator/owner que criou a conta consegue gerar um novo link depois,
  // pelo próprio Firebase Console, sem precisar refazer o cadastro).
  //
  // FIRESTORE_EMULATOR_HOST (setado por functions/test/run-all.js) sinaliza
  // execução local sob emulador — sem Secret Manager real disponível, uma
  // falha em accessSecretVersion() dispara uma rejeição de promise em segundo
  // plano (fora de qualquer try/catch daqui) que derruba o processo Node
  // inteiro, não só esta function. Pula o convite por e-mail nesse modo — o
  // mesmo padrão que billing-registry.test.js/callable-cross-tenant.test.js
  // já usam pra nunca tocar Secret Manager real durante os testes.
  let resetLink = null;
  let emailSent = false;
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email);
      emailSent = await sendAccountInviteEmail(email, nome, resetLink, {
        subject: 'Acesso ao Painel Master — defina sua senha',
        introText: 'Uma conta de administrador da plataforma foi criada para você. Defina sua senha para acessar o Painel Master:',
      });
    } catch (e) {
      console.warn(`createPlatformAdmin: falha ao gerar/enviar link de convite pra uid=${uid} (conta já criada, prosseguindo):`, e.message);
    }
  }

  await writePlatformAuditLog('platform_admin_criado', { uid, email, role }, context);
  console.log(`createPlatformAdmin: uid=${uid} role=${role} criado por caller=${caller.uid}`);
  return { success: true, uid, emailSent, resetLink: emailSent ? undefined : resetLink };
});

// Callable: ativa/desativa uma conta de equipe da plataforma (soft delete —
// mesmo padrão já usado em organizations/associados, nunca exclusão definitiva).
exports.setPlatformAdminStatus = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);

  const targetUid = data?.uid;
  const ativo = data?.ativo;
  if (!targetUid || typeof ativo !== 'boolean') {
    throw new functions.https.HttpsError('invalid-argument', 'uid e ativo (boolean) são obrigatórios.');
  }
  if (targetUid === caller.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Não é possível alterar o próprio status — peça a outro administrador ou owner.');
  }

  const targetRef = db.collection('platformAdmins').doc(targetUid);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Administrador de plataforma não encontrado.');
  }
  const targetRole = targetSnap.data().role;

  if (caller.role === 'administrator' && targetRole !== 'operator') {
    throw new functions.https.HttpsError('permission-denied', 'Administrator só pode ativar/desativar contas com papel operator.');
  }

  if (targetRole === 'owner' && ativo === false) {
    const othersSnap = await db.collection('platformAdmins')
      .where('role', '==', 'owner').where('ativo', '==', true).get();
    const remaining = othersSnap.docs.filter((d) => d.id !== targetUid);
    if (remaining.length === 0) {
      throw new functions.https.HttpsError('failed-precondition', 'Não é possível desativar o último owner ativo da plataforma.');
    }
  }

  await targetRef.update({ ativo, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await writePlatformAuditLog(ativo ? 'platform_admin_reativado' : 'platform_admin_desativado', { uid: targetUid }, context);
  console.log(`setPlatformAdminStatus: uid=${targetUid} ativo=${ativo} por caller=${caller.uid}`);
  return { success: true };
});

// Callable: altera o papel de uma conta de equipe da plataforma — owner apenas
// (ver Contexto/Riscos do plano da Fase 3.2: nenhuma das 3 mutações desta
// seção pode deixar uma escalada de privilégio possível).
exports.setPlatformAdminRole = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformOwner(context);

  const targetUid = data?.uid;
  const newRole = data?.newRole;
  if (!targetUid || !PLATFORM_ROLES.includes(newRole)) {
    throw new functions.https.HttpsError('invalid-argument', 'uid e newRole (operator/administrator/owner) são obrigatórios.');
  }
  if (targetUid === caller.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Não é possível alterar o próprio papel — peça a outro owner.');
  }

  const targetRef = db.collection('platformAdmins').doc(targetUid);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Administrador de plataforma não encontrado.');
  }
  const targetRole = targetSnap.data().role;

  if (targetRole === 'owner' && newRole !== 'owner') {
    const othersSnap = await db.collection('platformAdmins')
      .where('role', '==', 'owner').where('ativo', '==', true).get();
    const remaining = othersSnap.docs.filter((d) => d.id !== targetUid);
    if (remaining.length === 0) {
      throw new functions.https.HttpsError('failed-precondition', 'Não é possível rebaixar o último owner ativo da plataforma.');
    }
  }

  await targetRef.update({ role: newRole, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await writePlatformAuditLog('platform_admin_papel_alterado', { uid: targetUid, de: targetRole, para: newRole }, context);
  console.log(`setPlatformAdminRole: uid=${targetUid} ${targetRole}->${newRole} por caller=${caller.uid}`);
  return { success: true };
});

/* =========================================================================
   FEATURE FLAGS (Fase 3.8)
   — camada única de resolução (ver lib/features.js). resolveFeatureFlags é a
   ÚNICA porta de entrada do CLIENTE (nunca lê featureFlags/{flagKey} direto —
   ver comentário no topo de lib/features.js pro porquê: o doc agrega
   overrides de todas as organizações, exposição direta vazaria dado
   cross-tenant). As demais são gestão, restritas a Platform Administrator.
   ========================================================================= */

// Qualquer membro autenticado de uma organização resolve as flags DA PRÓPRIA
// organização. Platform staff pode opcionalmente passar orgId pra pré-
// visualizar o estado de outra organização (uso do Painel Master) — nunca o
// contrário (organização nunca escolhe orgId de outra).
exports.resolveFeatureFlags = functions.https.onCall(async (data, context) => {
  // Sem checagem de auth própria aqui — requirePlatformStaff/requireOrganizationMember
  // abaixo já exigem autenticação como primeiro passo de qualquer um dos dois ramos.
  let org;
  const requestedOrgId = data?.orgId ? String(data.orgId) : null;
  if (requestedOrgId) {
    await platformAuth.requirePlatformStaff(context);
    org = await organizationResolver.getOrganization(requestedOrgId);
    if (!org) throw new functions.https.HttpsError('not-found', `Organização "${requestedOrgId}" não encontrada.`);
    org = { orgId: requestedOrgId, environment: org.environment };
  } else {
    const member = await auth.requireOrganizationMember(context);
    const orgDoc = await organizationResolver.getOrganization(member.orgId);
    org = { orgId: member.orgId, environment: orgDoc?.environment };
  }

  const flags = await featureService.resolveAll(org);
  return { orgId: org.orgId, flags };
});

exports.createFeatureFlag = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const { key } = await featureService.createFlag({
    key: String(data?.key || '').trim(),
    description: String(data?.description || '').trim(),
    category: data?.category || 'other',
    environments: Array.isArray(data?.environments) ? data.environments : null,
    createdBy: caller.uid,
  });
  await writePlatformAuditLog('feature_flag_criada', { key, category: data?.category || 'other' }, context);
  console.log(`createFeatureFlag: key=${key} por caller=${caller.uid}`);
  return { key };
});

exports.setFeatureFlagStatus = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const key = String(data?.key || '').trim();
  if (!key) throw new functions.https.HttpsError('invalid-argument', 'key é obrigatória.');
  await featureService.setStatus(key, data?.status, { rolloutPercentage: data?.rolloutPercentage, updatedBy: caller.uid });
  await writePlatformAuditLog('feature_flag_status_alterado', { key, status: data?.status, rolloutPercentage: data?.rolloutPercentage ?? null }, context);
  console.log(`setFeatureFlagStatus: key=${key} status=${data?.status} por caller=${caller.uid}`);
  return { success: true };
});

exports.setFeatureFlagOverride = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const key = String(data?.key || '').trim();
  const orgId = String(data?.orgId || '').trim();
  if (!key || !orgId) throw new functions.https.HttpsError('invalid-argument', 'key e orgId são obrigatórios.');
  const value = data?.value === null ? null : data?.value === true;
  await featureService.setOverride(key, orgId, value, { updatedBy: caller.uid });
  await writePlatformAuditLog('feature_flag_override_alterado', { key, orgId, value }, context);
  console.log(`setFeatureFlagOverride: key=${key} orgId=${orgId} value=${value} por caller=${caller.uid}`);
  return { success: true };
});

exports.archiveFeatureFlag = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);
  const key = String(data?.key || '').trim();
  if (!key) throw new functions.https.HttpsError('invalid-argument', 'key é obrigatória.');
  await featureService.setArchived(key, data?.archived !== false, { updatedBy: caller.uid });
  await writePlatformAuditLog('feature_flag_arquivada', { key, archived: data?.archived !== false }, context);
  console.log(`archiveFeatureFlag: key=${key} archived=${data?.archived !== false} por caller=${caller.uid}`);
  return { success: true };
});

// ---- migratePlatformAdmins (onCall, uso único — bootstrap da Fase 3.2) ----
// Migra toda conta users/{uid} com role "master" pra um doc novo em
// platformAdmins/{uid} (role:"owner" — preserva capacidade plena, sem tentar
// adivinhar um papel menor). Idempotente: pula quem já tem doc em
// platformAdmins. NÃO apaga o users/{uid} antigo (não-destrutivo, reversível)
// — só neutraliza o campo role, pra ele parar de satisfazer qualquer checagem
// antiga por acidente durante a janela de transição.
//
// Problema de bootstrap deliberado: este é o ÚLTIMO uso legítimo do mecanismo
// velho (role=="master" plano, sem organizationResolver) — só pra dar partida
// no mecanismo novo. Por isso NÃO usa auth.requireOrganizationMaster (que
// exige orgId e lançaria failed-precondition se a conta master real não tiver
// orgId — exatamente a contradição não resolvida documentada no plano desta
// fase); lê o papel diretamente, sem depender de organização nenhuma.
exports.migratePlatformAdmins = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    }

    // Patch de segurança (Fase 3.6): o gate abaixo (role=="master" plano, sem
    // organizationResolver) é deliberadamente o mecanismo antigo — é o próprio
    // motivo desta function existir. Mas usar SÓ esse gate deixaria a
    // vulnerabilidade de auto-cadastro com role:"master" (já corrigida em
    // firestore.rules) virar, encadeada com esta function, uma escalada até
    // Platform Owner. Fecha a superfície de vez: só roda enquanto
    // platformAdmins ainda não tiver NENHUM documento — depois do primeiro
    // bootstrap real, este caminho nunca mais aceita chamada nenhuma, nem de
    // uma conta master legítima.
    const anyPlatformAdmin = await db.collection('platformAdmins').limit(1).get();
    if (!anyPlatformAdmin.empty) {
      throw new functions.https.HttpsError('failed-precondition', 'Bootstrap já foi executado — platformAdmins não está mais vazia. Use createPlatformAdmin (requer conta de plataforma existente) a partir de agora.');
    }

    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    if (!callerSnap.exists || mapRole(callerSnap.data().role) !== 'master') {
      throw new functions.https.HttpsError('permission-denied', 'Requer uma conta com papel master (mecanismo antigo — só pra dar bootstrap neste mecanismo novo).');
    }

    const usersSnap = await db.collection('users').get();
    const masterDocs = usersSnap.docs.filter((d) => mapRole(d.data().role) === 'master');

    const results = [];
    for (const doc of masterDocs) {
      const uid = doc.id;
      const userData = doc.data();

      const existing = await db.collection('platformAdmins').doc(uid).get();
      if (existing.exists) {
        results.push({ uid, action: 'ja_migrado' });
        continue;
      }

      let email = userData.email || null;
      try {
        const authRecord = await admin.auth().getUser(uid);
        email = authRecord.email || email;
      } catch (e) {
        console.warn(`migratePlatformAdmins: falha ao ler conta Auth de uid=${uid}:`, e.message);
      }

      await db.collection('platformAdmins').doc(uid).set({
        role: 'owner',
        nome: userData.nome || null,
        email,
        ativo: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: 'migration_fase3_2',
      });
      await doc.ref.update({
        role: 'migrado_para_platform_admins',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      results.push({ uid, email, action: 'migrado' });
    }

    await writePlatformAuditLog('migracao_platform_admins_executada', { results }, context);
    console.log('migratePlatformAdmins result:', results);
    return { total: masterDocs.length, results };
  });

/* =========================================================================
   PROVISIONAMENTO AUTOMÁTICO DE ORGANIZAÇÕES (Fase 3.3)
   — mecanismo oficial e único de criação de tenants. A orquestração em si
   (functions/lib/provisioning.js) não sabe nada de e-mail/Secret Manager;
   esta callable é a única responsável por decidir SE/QUANDO convidar o
   Organization Master, depois que todo o resto já terminou com sucesso.
   ========================================================================= */

// Callable: provisiona uma organização completa (doc + primeiro Organization
// Master + módulos do plano + estrutura de billing + branding básica + CMS
// mínimo) num fluxo único, idempotente. administrator ou owner de plataforma.
exports.provisionOrganization = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (data, context) => {
    const caller = await platformAuth.requirePlatformAdministrator(context);

    const orgId = String(data?.orgId || '').trim().toLowerCase().replace(/\s+/g, '_');
    const nome = String(data?.nome || '').trim();
    const planId = String(data?.planId || '').trim();
    const masterEmail = String(data?.master?.email || '').trim().toLowerCase();
    const masterNome = String(data?.master?.nome || '').trim();
    if (!orgId || !nome || !planId || !masterEmail || !masterNome) {
      throw new functions.https.HttpsError('invalid-argument', 'orgId, nome, planId e master{email,nome} são obrigatórios.');
    }

    const result = await provisioningService.provisionOrganization({
      orgId, nome, planId,
      master: { email: masterEmail, nome: masterNome },
      forceReprocess: !!data?.forceReprocess,
      requestedBy: caller.uid,
      requestedByEmail: context.auth?.token?.email || null,
      runId: data?.runId || undefined,
    });

    // Convite só depois de tudo dar certo, e só se a conta do Master foi
    // criada de verdade nesta execução (não reenvia convite num reprocessamento
    // que só pulou o passo por já ter sido feito antes) — ver Contexto do
    // plano da Fase 3.3. Mesma guarda de emulador que createPlatformAdmin já usa.
    let emailSent = false;
    let resetLink = null;
    if (result.readyForInvite && !process.env.FIRESTORE_EMULATOR_HOST) {
      try {
        resetLink = await admin.auth().generatePasswordResetLink(result.master.email);
        emailSent = await sendAccountInviteEmail(result.master.email, result.master.nome, resetLink, {
          subject: 'Sua organização está pronta — defina sua senha',
          introText: 'Sua organização foi criada na plataforma. Defina sua senha para acessar o painel administrativo:',
        });
      } catch (e) {
        console.warn(`provisionOrganization: falha ao gerar/enviar convite pro Master de orgId=${orgId} (organização já provisionada, prosseguindo):`, e.message);
      }
    }

    await writePlatformAuditLog('organizacao_provisionada', { orgId, planId, status: result.status, runId: result.runId }, context);
    console.log(`provisionOrganization: orgId=${orgId} status=${result.status} runId=${result.runId} por caller=${caller.uid}`);

    return { ...result, emailSent, resetLink: emailSent ? undefined : resetLink };
  });

/* =========================================================================
   FASE 3.5 — IDENTIDADE DO TENANT E DOMÍNIOS
   ========================================================================= */

// Callable: substitui o conjunto de domínios (principal + adicionais) de uma
// organização, com unicidade garantida contra todas as outras organizações.
// administrator ou owner de plataforma — mesmo gate de provisionOrganization.
exports.setOrganizationDomains = functions.https.onCall(async (data, context) => {
  const caller = await platformAuth.requirePlatformAdministrator(context);

  const orgId = String(data?.orgId || '').trim();
  const dominioPrincipal = data?.dominioPrincipal;
  const dominiosAlternativos = Array.isArray(data?.dominiosAlternativos) ? data.dominiosAlternativos : [];
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'orgId é obrigatório.');
  }

  const result = await domainsService.setOrganizationDomains({
    orgId, dominioPrincipal, dominiosAlternativos, requestedBy: caller.uid,
  });

  await writePlatformAuditLog('org_dominio_atualizado', {
    orgId, dominioPrincipal: result.dominioPrincipal, dominiosAlternativos: result.dominiosAlternativos,
  }, context);
  console.log(`setOrganizationDomains: orgId=${orgId} dominioPrincipal=${result.dominioPrincipal} por caller=${caller.uid}`);

  return result;
});

// Trigger: mantém organizations/{orgId}/public/branding sincronizado com o
// subconjunto seguro de organizations/{orgId} sempre que o documento pai
// muda — cobre tanto a Central de Configuração (Fase 3.4) quanto qualquer
// edição legada em admin_master_associacoes.html, sem depender de cada tela
// lembrar de sincronizar (ver functions/lib/organizationPublicSync.js).
exports.onOrganizationWritten = functions.firestore
  .document('organizations/{orgId}')
  .onWrite(async (change, context) => {
    const orgId = context.params.orgId;
    const publicRef = db.collection('organizations').doc(orgId).collection('public').doc('branding');

    if (!change.after.exists) {
      // Organização nunca é apagada de verdade pelo sistema (ver
      // firestore.rules) — cobre só o caso defensivo de um delete manual.
      await publicRef.delete().catch(() => {});
      return null;
    }

    const projection = computePublicBrandingProjection(
      change.after.data(),
      () => admin.firestore.FieldValue.serverTimestamp()
    );
    await publicRef.set(projection);
    return null;
  });

// ─── VALIDAÇÃO DE CPF ─────────────────────────────────────────────────────────

function validateCPF(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let r1 = (s * 10) % 11;
  if (r1 === 10 || r1 === 11) r1 = 0;
  if (r1 !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  let r2 = (s * 10) % 11;
  if (r2 === 10 || r2 === 11) r2 = 0;
  return r2 === parseInt(d[10]);
}

// Callable: audita CPFs de todos os associados ativos DA PRÓPRIA ORGANIZAÇÃO do chamador.
exports.auditCpfs = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const ausente  = [];
    const tamanho  = [];
    const invalido = [];
    const valido   = [];
    let inativos = 0;
    let naoAssociado = 0;

    for (const docSnap of usersSnap.docs) {
      const u = { uid: docSnap.id, ...docSnap.data() };
      if (u.ativo === false) { inativos++; continue; }
      const role = mapRole(u.role);
      if (role !== 'associado') { naoAssociado++; continue; }

      const cpfRaw = String(u.cpf || '').replace(/\D/g, '');
      const info = { uid: u.uid, nome: u.nome || '—', cpf: cpfRaw || '(vazio)' };

      if (!cpfRaw) ausente.push(info);
      else if (cpfRaw.length !== 11) tamanho.push({ ...info, digitos: cpfRaw.length });
      else if (!validateCPF(cpfRaw)) invalido.push(info);
      else valido.push(u.uid);
    }

    return {
      geradoEm: new Date().toISOString(),
      totais: {
        validos: valido.length, ausentes: ausente.length,
        tamanhoErrado: tamanho.length, invalidos: invalido.length,
        inativos, naoAssociado,
      },
      ausente, tamanhoErrado: tamanho, invalido,
    };
  });

// ─── AUDITORIA ASAAS ─────────────────────────────────────────────────────────

// Callable: diagnóstico de sincronização entre Firestore e provider, restrito à
// PRÓPRIA ORGANIZAÇÃO do chamador.
exports.auditAsaasSync = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    const caller = await auth.requireOrganizationAdmin(context);

    const usersSnap = await db.collection('users').where('orgId', '==', caller.orgId).get();
    const semAsaasId      = [];
    const semSubscription = [];
    let completos = 0, inativos = 0, semCpf = 0, naoAssociado = 0;

    for (const doc of usersSnap.docs) {
      const u = { uid: doc.id, ...doc.data() };

      if (u.ativo === false) { inativos++; continue; }
      const role = mapRole(u.role);
      if (role !== 'associado') { naoAssociado++; continue; }
      if (!u.cpf) { semCpf++; continue; }

      const info = {
        uid: u.uid, nome: u.nome || '—', cpf: u.cpf, planType: u.planType || '—',
        asaasId: u.asaasId || null, asaasSubscriptionId: u.asaasSubscriptionId || null,
      };

      if (!u.asaasId) semAsaasId.push(info);
      else if (!u.asaasSubscriptionId) semSubscription.push(info);
      else completos++;
    }

    return {
      geradoEm: new Date().toISOString(),
      totais: { inativos, semCpf, naoAssociado, semAsaasId: semAsaasId.length, semSubscription: semSubscription.length, completos },
      semAsaasId, semSubscription,
    };
  });

// ─── INSCRIÇÕES EM EVENTOS ───────────────────────────────────────────────────

/* =======================================================================
   createEventRegistration — inscreve participante em evento (sem auth)
   orgId resolvido dinamicamente a partir do PRÓPRIO evento (cms_events já
   grava orgId, ver Fase 0) — antes desta fase, o literal 'org_bonfim' estava
   hardcoded aqui (o mesmo padrão do G1, do lado servidor).
   ======================================================================= */
exports.createEventRegistration = functions.https.onCall(async (data, _context) => {
  const { eventoId, cpf, nome, telefone } = data || {};

  if (!eventoId || !cpf || !nome)
    throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos. Informe evento, CPF e nome.');

  const cpfDigits = String(cpf).replace(/\D/g, '');
  if (cpfDigits.length < 11)
    throw new functions.https.HttpsError('invalid-argument', 'CPF inválido.');

  const eventoSnap = await db.collection('cms_events').doc(eventoId).get();
  if (!eventoSnap.exists || eventoSnap.data().deleted)
    throw new functions.https.HttpsError('not-found', 'Evento não encontrado.');

  const evento = eventoSnap.data();
  const orgId = evento.orgId;
  if (!orgId)
    throw new functions.https.HttpsError('failed-precondition', 'Evento sem organização associada — contate o suporte.');

  if (!evento.permiteInscricao)
    throw new functions.https.HttpsError('failed-precondition', 'Inscrições não habilitadas para este evento.');

  if (!evento.ativo)
    throw new functions.https.HttpsError('failed-precondition', 'Evento inativo.');

  if (evento.dataEncerramento) {
    const deadline = evento.dataEncerramento.toDate ? evento.dataEncerramento.toDate() : new Date(evento.dataEncerramento);
    if (new Date() > deadline)
      throw new functions.https.HttpsError('failed-precondition', 'O prazo de inscrições para este evento encerrou.');
  }

  if (evento.maxInscritos > 0) {
    const countSnap = await db.collection('eventRegistrations')
      .where('eventoId', '==', eventoId)
      .where('orgId', '==', orgId)
      .where('status', 'in', ['ativo', 'confirmado'])
      .get();
    if (countSnap.size >= evento.maxInscritos)
      throw new functions.https.HttpsError('resource-exhausted', 'Vagas esgotadas para este evento.');
  }

  let resolvedUid = null;
  let resolvedNome = String(nome).trim();

  if (evento.somenteSocioEmDia) {
    const userSnap = await db.collection('users')
      .where('cpf', '==', cpfDigits)
      .where('orgId', '==', orgId)
      .limit(1)
      .get();

    if (userSnap.empty)
      throw new functions.https.HttpsError('not-found', 'CPF não encontrado como associado. Entre em contato com a secretaria do clube.');

    const userDoc = userSnap.docs[0];
    resolvedUid = userDoc.id;
    resolvedNome = userDoc.data().nome || resolvedNome;

    const summarySnap = await db.collection('users').doc(resolvedUid).collection('finance').doc('summary').get();
    let emDia = false;
    if (summarySnap.exists) {
      const s = summarySnap.data();
      if (s.exempt === true) {
        const exemptUntil = s.exemptUntil?.toDate?.();
        emDia = !exemptUntil || exemptUntil > new Date();
      } else {
        const nextDue = s.nextDue?.toDate?.() || s.activeUntil?.toDate?.();
        emDia = !!(nextDue && nextDue >= new Date());
      }
    }
    if (!emDia)
      throw new functions.https.HttpsError('permission-denied', 'INADIMPLENTE');
  } else {
    try {
      const userSnap = await db.collection('users')
        .where('cpf', '==', cpfDigits)
        .where('orgId', '==', orgId)
        .limit(1)
        .get();
      if (!userSnap.empty) resolvedUid = userSnap.docs[0].id;
    } catch (_) {}
  }

  const dupSnap = await db.collection('eventRegistrations')
    .where('eventoId', '==', eventoId)
    .where('cpf', '==', cpfDigits)
    .where('orgId', '==', orgId)
    .limit(1)
    .get();

  if (!dupSnap.empty) {
    const existing = dupSnap.docs[0];
    if (existing.data().status !== 'cancelado')
      return { duplicate: true, regId: existing.id, viewToken: existing.data().viewToken };
  }

  const { randomUUID } = require('crypto');
  const token     = randomUUID();
  const viewToken = randomUUID();

  const ref = await db.collection('eventRegistrations').add({
    orgId,
    eventoId,
    eventoTitulo: evento.titulo || '',
    uid:          resolvedUid,
    nome:         resolvedNome,
    cpf:          cpfDigits,
    telefone:     String(telefone || '').replace(/\D/g, ''),
    token,
    viewToken,
    status:       'ativo',
    registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    confirmedAt:  null,
    confirmedBy:  null,
    canceledAt:   null,
    canceledBy:   null,
  });

  return { regId: ref.id, viewToken };
});

/* =======================================================================
   confirmEventCheckin — confirma presença via token de QR Code
   Requer auth (admin/master/operador/adminView). Token é UUID (não
   adivinhável); mesmo assim, valida que o registro pertence à MESMA
   organização de quem está confirmando.
   ======================================================================= */
exports.confirmEventCheckin = functions.https.onCall(async (data, context) => {
  const caller = await auth.requireOrganizationMember(context);
  // Patch de segurança (Fase 3.6): o comentário acima sempre documentou a
  // intenção (staff, não qualquer associado) mas o guard não aplicava
  // isso — requireOrganizationMember sozinho aceita qualquer papel. Alinha
  // o código ao que já estava escrito como intenção.
  if (!['admin', 'master', 'operador', 'adminView'].includes(caller.role)) {
    throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin, master, operador ou adminView.');
  }

  const { token } = data || {};
  if (!token)
    throw new functions.https.HttpsError('invalid-argument', 'Token ausente.');

  const snap = await db.collection('eventRegistrations')
    .where('token', '==', token)
    .limit(1)
    .get();

  if (snap.empty) return { result: 'invalid' };

  const regDoc  = snap.docs[0];
  const reg     = regDoc.data();

  auth.assertSameOrganization(caller.orgId, reg.orgId, 'Este registro de inscrição pertence a outra organização.');

  if (reg.status === 'cancelado')
    return { result: 'canceled', nome: reg.nome, eventoTitulo: reg.eventoTitulo };

  if (reg.status === 'confirmado') {
    const when = reg.confirmedAt?.toDate?.()
      ?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) || '—';
    return { result: 'already_confirmed', nome: reg.nome, eventoTitulo: reg.eventoTitulo, confirmedAt: when };
  }

  await regDoc.ref.update({
    status:      'confirmado',
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    confirmedBy: context.auth.uid,
  });

  return { result: 'confirmed', nome: reg.nome, eventoTitulo: reg.eventoTitulo };
});
