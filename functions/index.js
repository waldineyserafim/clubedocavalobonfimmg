const functions = require('firebase-functions');

const admin = require('firebase-admin');

const nodemailer = require('nodemailer');

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const ASAAS_BASE_URL      = 'https://api.asaas.com/v3';
const ASAAS_SECRET        = 'projects/clubecavalobonfim/secrets/asaas-api-key/versions/latest';
const ASAAS_WEBHOOK_TOKEN         = 'projects/clubecavalobonfim/secrets/asaas-webhook-token/versions/latest';
const ASAAS_AUCTION_WEBHOOK_TOKEN = 'projects/clubecavalobonfim/secrets/asaas-auction-webhook-token/versions/latest';

// Mesma lógica do firebase.js: trim + normalize + includes
function mapRoleServer(r) {
  const n = (r || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
  if (n.includes('master'))       return 'master';
  if (n.includes('admin'))        return 'admin';
  if (n.includes('operador'))     return 'operador';
  if (n.includes('participante')) return 'participanteLeilao';
  return 'associado';
}

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

  const [version] = await secretClient.accessSecretVersion({

    name: name,

  });

  return version.payload.data.toString();

}

 

// Função agendada para rodar a cada 10 minutos (para teste)

exports.sendDailyPaymentReport = functions.pubsub.schedule('0 8 * * *')

  .timeZone('America/Sao_Paulo')

  .onRun(async (context) => {

    try {

      console.log('Iniciando envio de relatório diário de vencimentos');

     

      // Buscar credenciais do Secret Manager

      const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');

      const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');

     

      // Buscar todos os usuários

      const usersSnapshot = await db.collection('users').get();

     

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

          if (!sumSnap.empty) {

            summary = sumSnap.data();

          }

        } catch (errSum) {

          console.warn('Falha ao ler summary de', uid, errSum);

        }

       

        const m = computeMembership({ invoices: invDocs, summary });

       

        if (m.listCode === 'isento') continue;

       

        // Se não tiver nextDue, tentar calcular a partir das faturas

        let nextDue = m.nextDue;

        if (!nextDue) {

          // Buscar a data de vencimento mais recente ou fim de plano mais recente

          const allDueDates = invDocs.map(i => {

            const dueMs = i.dueDate?.toMillis?.() ?? (i.dueDate ? new Date(i.dueDate).getTime() : null);

            return dueMs;

          }).filter(d => d !== null);

         

          const allPlanEnds = invDocs.map(i => {

            const endMs = i.planEnd?.toMillis?.() ?? (i.planEnd ? new Date(i.planEnd).getTime() : null);

            return endMs;

          }).filter(d => d !== null);

         

          if (allDueDates.length > 0) {

            nextDue = Math.min(...allDueDates);

          } else if (allPlanEnds.length > 0) {

            nextDue = Math.max(...allPlanEnds);

          }

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

       

        // Vence hoje

        if (daysDiff === 0) {

          dueToday.push(userInfo);

        }

        // A vencer em 5 dias

        else if (daysDiff > 0 && daysDiff <= 5) {

          expiring5Days.push(userInfo);

        }

        // Vencido a mais de 10 dias

        else if (daysDiff < -10) {

          overdueMore10Days.push(userInfo);

        }

        // Vencido entre 5 e 10 dias

        else if (daysDiff < 0 && daysDiff >= -10) {

          overdue5to10Days.push(userInfo);

        }

      }

     

      const emailHtml = generateEmailHtml({

        expiring5Days,

        dueToday,

        overdue5to10Days,

        overdueMore10Days

      });

     

      const transporter = nodemailer.createTransport({

        service: 'gmail',

        auth: {

          user: emailUser,

          pass: emailPassword

        }

      });

     

      await transporter.sendMail({

        from: '"Clube do Cavalo Bonfim MG" <contato@clubedocavalobonfim.com.br>',

        to: 'Waldiney.serafim@gmail.com, mpmarquesnutri@gmail.com',

        subject: `CCBMG - Relatório de Associados - ${formatDateBR(now)}`,

        html: emailHtml

      });

     

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

 

// Função auxiliar para gerar HTML do email

function generateEmailHtml(data) {

  return `

<!DOCTYPE html>

<html>

<head>

  <meta charset="UTF-8">

  <style>

    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }

    .container { max-width: 800px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }

    h1 { color: #333; text-align: center; margin-bottom: 30px; }

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

    <h1>CCBMG - Relatório de Associados</h1>

    <p style="text-align: center; color: #666;">Data: ${formatDateBR(new Date())}</p>

   

    ${data.dueToday.length > 0 ? `

    <h2 class="danger">Vence Hoje (${data.dueToday.length})</h2>

    <table>

      <thead>

        <tr>

          <th>Nome</th>

          <th>Apelido</th>

          <th>Telefone</th>

          <th>Vencimento</th>

        </tr>

      </thead>

      <tbody>

        ${data.dueToday.map(user => `

          <tr>

            <td>${escHtml(user.nome)}</td>

            <td>${escHtml(user.apelido || '—')}</td>

            <td>${escHtml(user.telefone || '—')}</td>

            <td>${escHtml(user.vencimento)}</td>

          </tr>

        `).join('')}

      </tbody>

    </table>

    ` : ''}

   

    ${data.expiring5Days.length > 0 ? `

    <h2 class="warning">À Vencer em 5 Dias (${data.expiring5Days.length})</h2>

    <table>

      <thead>

        <tr>

          <th>Nome</th>

          <th>Apelido</th>

          <th>Telefone</th>

          <th>Vencimento</th>

        </tr>

      </thead>

      <tbody>

        ${data.expiring5Days.map(user => `

          <tr>

            <td>${escHtml(user.nome)}</td>

            <td>${escHtml(user.apelido || '—')}</td>

            <td>${escHtml(user.telefone || '—')}</td>

            <td>${escHtml(user.vencimento)}</td>

          </tr>

        `).join('')}

      </tbody>

    </table>

    ` : ''}

   

    ${data.overdueMore10Days.length > 0 ? `

    <h2 class="danger">Vencido a mais de 10 Dias (${data.overdueMore10Days.length})</h2>

    <table>

      <thead>

        <tr>

          <th>Nome</th>

          <th>Apelido</th>

          <th>Telefone</th>

          <th>Vencimento</th>

          <th>Dias de Atraso</th>

        </tr>

      </thead>

      <tbody>

        ${data.overdueMore10Days.map(user => `

          <tr>

            <td>${escHtml(user.nome)}</td>

            <td>${escHtml(user.apelido || '—')}</td>

            <td>${escHtml(user.telefone || '—')}</td>

            <td>${escHtml(user.vencimento)}</td>

            <td>${Math.abs(user.diasAtraso)} dias</td>

          </tr>

        `).join('')}

      </tbody>

    </table>

    ` : ''}

   

    ${data.overdue5to10Days.length > 0 ? `

    <h2 class="warning">Vencido entre 5 e 10 Dias (${data.overdue5to10Days.length})</h2>

    <table>

      <thead>

        <tr>

          <th>Nome</th>

          <th>Apelido</th>

          <th>Telefone</th>

          <th>Vencimento</th>

          <th>Dias de Atraso</th>

        </tr>

      </thead>

      <tbody>

        ${data.overdue5to10Days.map(user => `

          <tr>

            <td>${escHtml(user.nome)}</td>

            <td>${escHtml(user.apelido || '—')}</td>

            <td>${escHtml(user.telefone || '—')}</td>

            <td>${escHtml(user.vencimento)}</td>

            <td>${Math.abs(user.diasAtraso)} dias</td>

          </tr>

        `).join('')}

      </tbody>

    </table>

    ` : ''}

   

    ${data.expiring5Days.length === 0 && data.dueToday.length === 0 && data.overdue5to10Days.length === 0 && data.overdueMore10Days.length === 0 ? `

    <p style="text-align: center; color: #666; margin-top: 30px;">Nenhum associado com vencimento próximo encontrado.</p>

    ` : ''}

   

    <div class="footer">

      <p>Relatório gerado automaticamente pelo sistema CCBMG - Clube do Cavalo Bonfim MG</p>

    </div>

  </div>

</body>

</html>

  `;

}

/* =======================================================================
   INTEGRAÇÃO ASAAS
   ======================================================================= */

async function getAsaasApiKey() {
  return getSecret(ASAAS_SECRET);
}

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

// Sincroniza pagamento manual do Firebase → Asaas
// Só executa se a fatura NÃO tem asaasPaymentId (ou seja, não veio do webhook)
async function syncManualPaymentToAsaas(uid, invoiceRef, invoiceData) {
  if (invoiceData.asaasPaymentId) return; // já sincronizado via webhook

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return;
  const userData = userSnap.data();
  if (!userData.asaasId || !userData.asaasSubscriptionId) return;

  const apiKey = await getAsaasApiKey();

  const dueDateMs = invoiceData.dueDate?.toMillis?.()
    ?? (invoiceData.dueDate ? new Date(invoiceData.dueDate).getTime() : null);
  if (!dueDateMs) return;

  const dueDateStr = new Date(dueDateMs).toISOString().slice(0, 10);

  // Busca cobranças pendentes e vencidas da assinatura com a mesma dueDate
  const [pendingResp, overdueResp] = await Promise.all([
    fetch(`${ASAAS_BASE_URL}/payments?subscription=${userData.asaasSubscriptionId}&status=PENDING`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }),
    fetch(`${ASAAS_BASE_URL}/payments?subscription=${userData.asaasSubscriptionId}&status=OVERDUE`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }),
  ]);
  const [pendingData, overdueData] = await Promise.all([
    pendingResp.text().then(t => t ? JSON.parse(t) : {}),
    overdueResp.text().then(t => t ? JSON.parse(t) : {}),
  ]);
  const allCharges = [...(pendingData.data || []), ...(overdueData.data || [])];

  const charge = allCharges.find(c => c.dueDate === dueDateStr);
  if (!charge) {
    console.warn(`syncManualPaymentToAsaas: cobrança não encontrada para uid=${uid} dueDate=${dueDateStr}`);
    return;
  }

  const paidAt = invoiceData.paidAt?.toDate?.() ?? invoiceData.recordedAt?.toDate?.() ?? new Date();
  const receiveResp = await fetch(`${ASAAS_BASE_URL}/payments/${charge.id}/receiveInCash`, {
    method: 'POST',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentDate: paidAt.toISOString().slice(0, 10),
      value: invoiceData.amount || charge.value,
    }),
  });
  const receiveText = await receiveResp.text();
  const receiveData = receiveText ? JSON.parse(receiveText) : {};

  if (!receiveResp.ok) {
    throw new Error(receiveData.errors?.[0]?.description || `HTTP ${receiveResp.status}`);
  }

  // Salva asaasPaymentId na fatura para idempotência (+ billingType/invoiceNumber para exibição no painel)
  await invoiceRef.update({
    asaasPaymentId: charge.id,
    billingType:    charge.billingType || null,
    invoiceNumber:  charge.invoiceNumber || null,
  });
  console.log(`syncManualPaymentToAsaas: uid=${uid} charge=${charge.id} marcado como pago no Asaas`);
}

// Traduz o estado de um payment do Asaas para o vocabulário local de financeInvoices.
// `deleted` é um campo booleano independente de `status` (confirmado via API) — uma cobrança
// excluída (PAYMENT_DELETED) mantém seu `status` anterior, então precisa ser checado primeiro.
// Isso também cobre PAYMENT_RESTORED "de graça": ao restaurar, `deleted` volta a false e o
// `status` natural (PENDING/OVERDUE/...) já reflete o estado correto, sem caso especial.
function mapAsaasPaymentStatus(payment) {
  if (payment.deleted === true) return 'cancelado';
  switch (payment.status) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
      return 'pago';
    case 'OVERDUE':
      return 'atrasado';
    case 'PENDING':
      return 'em_aberto';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
      return 'estornado';
    default:
      return 'em_aberto';
  }
}

// Cria ou atualiza uma financeInvoice a partir de um objeto payment do Asaas (idempotente por asaasPaymentId).
// Usado pelo webhook, pela sincronização manual sob demanda, pela reconciliação diária e pelo
// cancelamento/reativação de associado — única fonte da lógica de "achar/criar invoice por
// dueDate ou por asaasPaymentId" para evitar divergência entre as rotinas. Entende qualquer
// estado de cobrança (pago/pendente/vencido/cancelado), embora hoje só receba pagas e as
// cobranças canceladas/recriadas pelo fluxo de desativação/reativação.
async function upsertInvoiceFromAsaasPayment(uid, payment) {
  const invoicesRef = db.collection('users').doc(uid).collection('financeInvoices');

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { action: 'skipped', reason: 'user_not_found' };

  const planType  = String(userSnap.data().planType || 'mensal').toLowerCase().trim();
  const dueDate   = new Date(payment.dueDate);
  const planStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
  const planEnd   = calculatePlanEnd(planStart, planType);
  const now       = admin.firestore.FieldValue.serverTimestamp();
  const status    = mapAsaasPaymentStatus(payment);

  const paymentPayload = {
    status,
    amount:         payment.value,
    asaasPaymentId: payment.id,
    invoiceUrl:     payment.invoiceUrl || null,
    billingType:    payment.billingType || null,
    invoiceNumber:  payment.invoiceNumber || null,
    planType,
    planStart:      admin.firestore.Timestamp.fromDate(planStart),
    planEnd:        admin.firestore.Timestamp.fromDate(planEnd),
    updatedAt:      now,
  };

  // Só grava data de pagamento quando o pagamento é real — nunca usar "agora" como fallback
  // para uma cobrança que não foi paga (isso carimbaria uma data de pagamento falsa).
  if (status === 'pago') {
    const paidAt = new Date(payment.paymentDate || payment.confirmedDate || payment.clientPaymentDate || Date.now());
    paymentPayload.paidAt = admin.firestore.Timestamp.fromDate(paidAt);
  }

  // 1) Já existe fatura vinculada a este payment.id? Converge (upsert) — cobre todo o ciclo de
  //    vida da mesma cobrança (criada → vencida → paga, ou criada → cancelada) sem duplicar.
  const byPaymentId = await invoicesRef.where('asaasPaymentId', '==', payment.id).limit(1).get();
  if (!byPaymentId.empty) {
    await byPaymentId.docs[0].ref.update(paymentPayload);
    return { action: 'updated', invoiceId: byPaymentId.docs[0].id };
  }

  // 2) Fatura pré-existente sem asaasPaymentId ainda (criada manualmente/migração), mesma
  //    dueDate e em aberto — vincula a este payment ao invés de duplicar.
  const existingSnap = await invoicesRef
    .where('dueDate', '==', admin.firestore.Timestamp.fromDate(dueDate))
    .where('status', 'in', ['em_aberto', 'atrasado', 'vencido'])
    .limit(1).get();

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.update(paymentPayload);
    return { action: 'updated', invoiceId: existingSnap.docs[0].id };
  }

  // 3) Não havia nada — cria uma fatura nova espelhando esta cobrança do Asaas.
  const newRef = await invoicesRef.add({
    ...paymentPayload,
    dueDate:   admin.firestore.Timestamp.fromDate(dueDate),
    createdAt: now,
  });
  return { action: 'created', invoiceId: newRef.id };
}

// Busca cliente no Asaas (por externalReference, com fallback por CPF); cria se não existir.
// Retorna { asaasId, action: 'found' | 'created' }
async function findOrCreateAsaasCustomer(apiKey, user) {
  const isMirim = user.categoriaAssociado === 'mirim';
  const cpf = ((isMirim ? user.responsavelCpf : user.cpf) || '').replace(/\D/g, '');
  if (!cpf) throw new Error(isMirim ? 'CPF do responsável ausente' : 'CPF ausente');

  // 1) Casa por externalReference (UID Firebase) — idempotente e correto tanto para mirim
  //    quanto para associado normal, sem depender do CPF.
  if (user.uid) {
    const refResp = await fetch(
      `${ASAAS_BASE_URL}/customers?externalReference=${user.uid}`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
    );
    const refData = await refResp.json();
    if (refData.data && refData.data.length > 0) {
      return { asaasId: refData.data[0].id, action: 'found' };
    }
  }

  // 2) Só para associado normal: casa por CPF — cobre clientes já cadastrados manualmente no
  //    Asaas ANTES da integração (sem externalReference ainda). Não se aplica a mirim: o CPF
  //    é do responsável, então casar por ele encontraria o cliente ERRADO (o do próprio
  //    responsável, se ele também for associado) em vez de criar um cliente distinto pro mirim.
  //    O Asaas permite clientes duplicados por CPF — é seguro criar um novo para o mirim.
  if (!isMirim) {
    const cpfResp = await fetch(
      `${ASAAS_BASE_URL}/customers?cpfCnpj=${cpf}`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
    );
    const cpfData = await cpfResp.json();
    if (cpfData.data && cpfData.data.length > 0) {
      return { asaasId: cpfData.data[0].id, action: 'found' };
    }
  }

  // 3) Cria novo cliente
  const nome = isMirim
    ? `${(user.nome || 'Associado').trim()} (Mirim) — resp. ${(user.responsavelNome || '').trim()}`
    : (user.nome || 'Associado').trim();
  const telefone = isMirim ? user.responsavelTelefone : user.telefone;

  const body = {
    name: nome,
    cpfCnpj: cpf,
    mobilePhone: formatPhoneForAsaas(telefone),
    externalReference: user.uid || undefined,
  };

  const createResp = await fetch(`${ASAAS_BASE_URL}/customers`, {
    method: 'POST',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const createData = await createResp.json();

  if (!createResp.ok) {
    const msg = createData.errors?.[0]?.description || `HTTP ${createResp.status}`;
    throw new Error(msg);
  }

  return { asaasId: createData.id, action: 'created' };
}

// Callable: sincroniza todos os associados sem asaasId com o Asaas.
// Requer role admin ou master.
exports.syncAllAssociadosToAsaas = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }

    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey = await getAsaasApiKey();
    const usersSnap = await db.collection('users').get();
    const results = { synced: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (userData.asaasId || userData.ativo === false) {
        results.skipped++;
        continue;
      }

      try {
        const { asaasId } = await findOrCreateAsaasCustomer(apiKey, userData);
        await userDoc.ref.update({
          asaasId,
          asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        results.synced++;
      } catch (err) {
        console.error('Asaas sync error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: err.message });
      }

      // Pausa para respeitar rate limits do Asaas
      await new Promise(r => setTimeout(r, 250));
    }

    console.log('syncAllAssociadosToAsaas result:', results);
    return results;
  });

// Trigger: ao criar um novo usuário → cria cliente e assinatura no Asaas automaticamente.
exports.onNewAssociadoCriado = functions.firestore
  .document('users/{uid}')
  .onCreate(async (snap, context) => {
    const uid      = context.params.uid;
    const userData = { uid, ...snap.data() };
    const isMirim  = userData.categoriaAssociado === 'mirim';
    const cpfDisponivel = isMirim ? userData.responsavelCpf : userData.cpf;
    if (!cpfDisponivel || userData.ativo === false) return null;

    try {
      const apiKey  = await getAsaasApiKey();
      const { asaasId, action } = await findOrCreateAsaasCustomer(apiKey, userData);

      // Notificações (WhatsApp + SMS) precisam estar configuradas antes de
      // criar a assinatura, para que a 1ª cobrança já saia com o padrão certo.
      const notifResult = await syncCustomerNotifications(asaasId, apiKey);
      console.log(`onNewAssociadoCriado: uid=${uid} asaasId=${asaasId} notificações ajustadas=${notifResult.changed}/${notifResult.total}`);

      const planType    = String(userData.planType || 'mensal').toLowerCase().trim();
      const nextDueDate = getNextDueDate();
      const value       = resolvePlanValue(planType, userData.categoriaAssociado);
      const descricao   = `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType] || 'Mensal'}${isMirim ? ' (Mirim)' : ''}`;

      const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
        method: 'POST',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer:          asaasId,
          billingType:       'UNDEFINED',
          value,
          nextDueDate,
          cycle:             PLAN_CYCLE[planType] || 'MONTHLY',
          description:       descricao,
          externalReference: uid,
          interest:          { value: 0.01 },
          notificationEnabled: true,
        }),
      });
      const subText = await subResp.text();
      const subData = subText ? JSON.parse(subText) : {};

      await snap.ref.update({
        asaasId,
        asaasSyncedAt:              admin.firestore.FieldValue.serverTimestamp(),
        asaasSubscriptionId:        subData.id || null,
        asaasSubscriptionSyncedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`onNewAssociadoCriado: uid=${uid} asaasId=${asaasId} action=${action} subscriptionId=${subData.id}`);
    } catch (err) {
      console.error('onNewAssociadoCriado error:', uid, err.message);
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

// Callable: cria assinaturas no Asaas para todos os associados com asaasId
exports.createAsaasSubscriptions = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }

    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey = await getAsaasApiKey();
    const usersSnap = await db.collection('users').get();
    const results = { created: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      // Pula sem asaasId, já com assinatura ou inativos
      if (!userData.asaasId || userData.asaasSubscriptionId || userData.ativo === false) {
        results.skipped++;
        continue;
      }

      try {
        const invSnap = await db
          .collection('users').doc(userDoc.id)
          .collection('financeInvoices').get();
        const invoices = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const planType = detectPlanType(invoices, userData.planType);

        // Define data de vencimento da 1ª cobrança
        const membership = computeMembership({ invoices, summary: {} });
        let nextDueDate;

        if (membership.listCode === 'em_dia') {
          const planEnd = getLastPlanEndDate(invoices);
          nextDueDate = planEnd
            ? planEnd.toISOString().slice(0, 10)
            : getPendingRestartDate();
        } else {
          nextDueDate = getPendingRestartDate();
        }

        const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
          method: 'POST',
          headers: { access_token: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer: userData.asaasId,
            billingType: 'UNDEFINED',
            value: resolvePlanValue(planType, userData.categoriaAssociado),
            nextDueDate,
            cycle: PLAN_CYCLE[planType],
            description: `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType]}${userData.categoriaAssociado === 'mirim' ? ' (Mirim)' : ''}`,
            externalReference: userDoc.id,
            interest: { value: 0.01 },
            notificationEnabled: true,
          }),
        });
        const subData = await subResp.json();

        if (!subResp.ok) {
          throw new Error(subData.errors?.[0]?.description || `HTTP ${subResp.status}`);
        }

        const updatePayload = {
          asaasSubscriptionId: subData.id,
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


/* =======================================================================
   ASAAS — PADRÃO DE NOTIFICAÇÕES (WhatsApp + SMS)
   ======================================================================= */

// Eventos padrão criados automaticamente pelo Asaas para cada cliente
// (PAYMENT_CREATED, PAYMENT_UPDATED, PAYMENT_RECEIVED, PAYMENT_OVERDUE,
// PAYMENT_DUEDATE_WARNING, SEND_LINHA_DIGITAVEL — alguns duplicados com
// scheduleOffset diferente). SEND_LINHA_DIGITAVEL não aceita ativação de
// WhatsApp (confirmado via teste em Sandbox); mantido como Set para permitir
// fallback dinâmico caso o Asaas passe a rejeitar outro evento no futuro.
const WHATSAPP_UNSUPPORTED_EVENTS = new Set(['SEND_LINHA_DIGITAVEL']);

// Aplica o padrão institucional (WhatsApp + SMS ativos; e-mail e ligação
// desativados) às notificações de 1 cliente do Asaas. Preserva scheduleOffset
// e os campos *ForProvider (não são enviados no payload, então a API mantém
// o valor atual). PUT /notifications/batch é atômico — se 1 notificação for
// rejeitada, o lote inteiro falha — por isso o fallback abaixo reenvia sem o
// campo problemático em vez de abortar a sincronização do cliente inteiro.
async function syncCustomerNotifications(asaasId, apiKey) {
  const listResp = await fetch(
    `${ASAAS_BASE_URL}/customers/${asaasId}/notifications`,
    { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
  );
  const listText = await listResp.text();
  const listData = listText ? JSON.parse(listText) : {};
  if (!listResp.ok) {
    throw new Error(listData.errors?.[0]?.description || `HTTP ${listResp.status}`);
  }

  const notifications = listData.data || [];
  const byId = new Map(notifications.map(n => [n.id, n]));
  const unsupported = new Set(WHATSAPP_UNSUPPORTED_EVENTS);

  const buildChanged = () => notifications.reduce((acc, notif) => {
    const desired = {
      enabled:                     true,
      whatsappEnabledForCustomer:  !unsupported.has(notif.event),
      smsEnabledForCustomer:       true,
      emailEnabledForCustomer:     false,
      phoneCallEnabledForCustomer: false,
    };
    const isDifferent = Object.entries(desired).some(([k, v]) => notif[k] !== v);
    if (isDifferent) acc.push({ id: notif.id, ...desired });
    return acc;
  }, []);

  for (let attempt = 0; attempt <= notifications.length; attempt++) {
    const changed = buildChanged();
    if (!changed.length) return { total: notifications.length, changed: 0 };

    const updResp = await fetch(`${ASAAS_BASE_URL}/notifications/batch`, {
      method: 'PUT',
      headers: { access_token: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: asaasId, notifications: changed }),
    });
    if (updResp.ok) return { total: notifications.length, changed: changed.length };

    const updText = await updResp.text();
    const updData = updText ? JSON.parse(updText) : {};
    const msg = updData.errors?.[0]?.description || `HTTP ${updResp.status}`;

    // Só sabemos contornar rejeição de WhatsApp para um evento específico;
    // qualquer outro erro propaga e interrompe a sincronização desse cliente.
    const m = msg.match(/notifica(?:ç|c)ão (not_\w+).*whatsapp/i);
    const badNotif = m && byId.get(m[1]);
    if (!badNotif || unsupported.has(badNotif.event)) throw new Error(msg);
    unsupported.add(badNotif.event);
  }
  throw new Error('Excedeu tentativas de ajuste do lote de notificações.');
}

// Liga/desliga TODAS as notificações de um cliente de uma vez (usado na desativação de
// associado). Diferente de syncCustomerNotifications (que aplica o padrão institucional
// completo por evento/canal), aqui só o campo `enabled` importa.
async function setCustomerNotificationsEnabled(asaasId, apiKey, enabled) {
  const listResp = await fetch(
    `${ASAAS_BASE_URL}/customers/${asaasId}/notifications`,
    { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
  );
  const listText = await listResp.text();
  const listData = listText ? JSON.parse(listText) : {};
  if (!listResp.ok) throw new Error(listData.errors?.[0]?.description || `HTTP ${listResp.status}`);

  const notifications = listData.data || [];
  const changed = notifications.filter(n => n.enabled !== enabled).map(n => ({ id: n.id, enabled }));
  if (!changed.length) return { total: notifications.length, changed: 0 };

  const updResp = await fetch(`${ASAAS_BASE_URL}/notifications/batch`, {
    method: 'PUT',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer: asaasId, notifications: changed }),
  });
  if (!updResp.ok) {
    const updText = await updResp.text();
    const updData = updText ? JSON.parse(updText) : {};
    throw new Error(updData.errors?.[0]?.description || `HTTP ${updResp.status}`);
  }
  return { total: notifications.length, changed: changed.length };
}

// Cancela (DELETE) todas as cobranças em aberto (PENDING + OVERDUE) de um cliente no Asaas —
// usado na desativação de associado, para que nada continue vencendo depois que ele saiu.
// Espelha cada cancelamento como 'cancelado' no financeInvoices correspondente, sem round-trip
// extra: já sabemos que a exclusão deu certo, então marcamos deleted:true localmente.
async function cancelOpenPayments(uid, asaasId, apiKey) {
  const [pendingResp, overdueResp] = await Promise.all([
    fetch(`${ASAAS_BASE_URL}/payments?customer=${asaasId}&status=PENDING`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }),
    fetch(`${ASAAS_BASE_URL}/payments?customer=${asaasId}&status=OVERDUE`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }),
  ]);
  const [pendingData, overdueData] = await Promise.all([
    pendingResp.text().then(t => t ? JSON.parse(t) : {}),
    overdueResp.text().then(t => t ? JSON.parse(t) : {}),
  ]);
  if (!pendingResp.ok || !overdueResp.ok) {
    throw new Error(pendingData.errors?.[0]?.description || overdueData.errors?.[0]?.description || 'Falha ao listar cobranças em aberto.');
  }
  const openPayments = [...(pendingData.data || []), ...(overdueData.data || [])];

  let canceled = 0;
  for (const payment of openPayments) {
    const delResp = await fetch(`${ASAAS_BASE_URL}/payments/${payment.id}`, {
      method: 'DELETE',
      headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    });
    if (!delResp.ok) {
      console.warn(`cancelOpenPayments: falha ao cancelar payment=${payment.id} uid=${uid}: HTTP ${delResp.status}`);
      continue; // não interrompe os demais por causa de 1 falha isolada
    }
    canceled++;
    await upsertInvoiceFromAsaasPayment(uid, { ...payment, deleted: true });
  }
  return { found: openPayments.length, canceled };
}

// Cria uma cobrança avulsa imediata ao reativar um associado — equivalente a reiniciar o plano
// hoje, em vez de esperar o próximo ciclo natural da assinatura (que pode estar meses à frente
// sem cobrar nada nesse meio-tempo). Espelhada no Firestore via o mesmo upsert de sempre.
async function createImmediateChargeOnReactivation(uid, after, apiKey) {
  const planType = String(after.planType || 'mensal').toLowerCase().trim();
  const value = resolvePlanValue(planType, after.categoriaAssociado);
  const today = new Date().toISOString().slice(0, 10);

  const resp = await fetch(`${ASAAS_BASE_URL}/payments`, {
    method: 'POST',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer:    after.asaasId,
      billingType: 'UNDEFINED',
      value,
      dueDate:     today,
      description: `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType] || 'Mensal'} (reativação)`,
    }),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(data.errors?.[0]?.description || `HTTP ${resp.status}`);

  await upsertInvoiceFromAsaasPayment(uid, data);
  return data;
}

// Callable: aplica o padrão institucional de notificações (WhatsApp + SMS
// ativos; e-mail e ligação desativados) a TODOS os clientes cadastrados no
// Asaas — não apenas os associados atualmente no Firestore.
exports.configureAsaasNotifications = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey  = await getAsaasApiKey();
    const results = { totalClientes: 0, atualizados: 0, ignorados: 0, errors: [] };
    const limit   = 100;
    let offset    = 0;

    while (true) {
      const listResp = await fetch(
        `${ASAAS_BASE_URL}/customers?limit=${limit}&offset=${offset}`,
        { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
      );
      const listText = await listResp.text();
      const listData = listText ? JSON.parse(listText) : {};
      if (!listResp.ok) {
        throw new functions.https.HttpsError('internal', listData.errors?.[0]?.description || `HTTP ${listResp.status}`);
      }

      for (const customer of (listData.data || [])) {
        results.totalClientes++;
        try {
          const { changed } = await syncCustomerNotifications(customer.id, apiKey);
          if (changed > 0) results.atualizados++; else results.ignorados++;
        } catch (err) {
          console.error('configureAsaasNotifications error:', customer.id, err.message);
          results.errors.push({ asaasId: customer.id, nome: customer.name || '—', error: err.message });
        }
        await new Promise(r => setTimeout(r, 150));
      }

      if (!listData.hasMore) break;
      offset += limit;
    }

    console.log('configureAsaasNotifications result:', results);
    return results;
  });

// Callable (diagnóstico, somente leitura): lista todos os clientes cadastrados
// diretamente no Asaas (id, nome, cpfCnpj, externalReference), para cruzar com
// os associados do Firestore e identificar quem ainda não tem cliente no Asaas.
exports.listAsaasCustomersRaw = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey    = await getAsaasApiKey();
    const customers  = [];
    const limit = 100;
    let offset  = 0;

    while (true) {
      const listResp = await fetch(
        `${ASAAS_BASE_URL}/customers?limit=${limit}&offset=${offset}`,
        { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
      );
      const listText = await listResp.text();
      const listData = listText ? JSON.parse(listText) : {};
      if (!listResp.ok) {
        throw new functions.https.HttpsError('internal', listData.errors?.[0]?.description || `HTTP ${listResp.status}`);
      }

      for (const c of (listData.data || [])) {
        customers.push({ id: c.id, name: c.name, cpfCnpj: c.cpfCnpj, externalReference: c.externalReference || null });
      }

      if (!listData.hasMore) break;
      offset += limit;
    }

    return { total: customers.length, customers };
  });

// Callable (auditoria, somente leitura): abre a notificação individual de
// TODOS os clientes do Asaas e confere, notificação por notificação, se o
// padrão institucional (WhatsApp + SMS ativos, e-mail e ligação desativados)
// está realmente aplicado — não confia no contador agregado de
// configureAsaasNotifications, lê o estado atual direto da API.
exports.verifyAsaasNotificationStandard = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey = await getAsaasApiKey();
    const counts = {
      totalClientes: 0,
      totalNotificacoes: 0,
      whatsappAtivo: 0,
      whatsappInativo: 0,
      smsAtivo: 0,
      smsInativo: 0,
      emailAtivo: 0,
      ligacaoAtiva: 0,
    };
    const whatsappInativoPorEvento = {};
    const naoConformes = []; // qualquer notificação fora do padrão, exceto a exceção conhecida (SEND_LINHA_DIGITAVEL sem whatsapp)
    const limit = 100;
    let offset  = 0;

    while (true) {
      const listResp = await fetch(
        `${ASAAS_BASE_URL}/customers?limit=${limit}&offset=${offset}`,
        { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
      );
      const listText = await listResp.text();
      const listData = listText ? JSON.parse(listText) : {};
      if (!listResp.ok) {
        throw new functions.https.HttpsError('internal', listData.errors?.[0]?.description || `HTTP ${listResp.status}`);
      }

      for (const customer of (listData.data || [])) {
        counts.totalClientes++;

        const notifResp = await fetch(
          `${ASAAS_BASE_URL}/customers/${customer.id}/notifications`,
          { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
        );
        const notifText = await notifResp.text();
        const notifData = notifText ? JSON.parse(notifText) : {};
        if (!notifResp.ok) {
          naoConformes.push({ asaasId: customer.id, nome: customer.name, erro: notifData.errors?.[0]?.description || `HTTP ${notifResp.status}` });
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        for (const n of (notifData.data || [])) {
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
            naoConformes.push({ asaasId: customer.id, nome: customer.name, notifId: n.id, event: n.event, notif: n });
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }

      if (!listData.hasMore) break;
      offset += limit;
    }

    return { counts, whatsappInativoPorEvento, naoConformes };
  });

// Callable: corrige os telefones no Asaas para todos os associados com asaasId
exports.fixAsaasPhoneNumbers = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const apiKey   = await getAsaasApiKey();
    const usersSnap = await db.collection('users').get();
    const results  = { updated: 0, skipped: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (!userData.asaasId || !userData.telefone) { results.skipped++; continue; }

      const phone = formatPhoneForAsaas(userData.telefone);
      if (!phone) { results.skipped++; continue; }

      try {
        const resp = await fetch(`${ASAAS_BASE_URL}/customers/${userData.asaasId}`, {
          method: 'POST',
          headers: { access_token: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobilePhone: phone }),
        });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};

        if (!resp.ok) {
          throw new Error(data.errors?.[0]?.description || `HTTP ${resp.status}`);
        }
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

// Trigger: quando dados cadastrais do associado mudam → atualiza cliente no Asaas
exports.onAssociadoAtualizado = functions.firestore
  .document('users/{uid}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    if (!after.asaasId) return null;

    const isMirim         = after.categoriaAssociado === 'mirim';
    // Mirim é cobrado nos dados do responsável — só esses campos importam para o Asaas.
    const dataChanged     = isMirim
      ? ['nome', 'responsavelNome', 'responsavelCpf', 'responsavelTelefone'].some(f => before[f] !== after[f])
      : ['nome', 'telefone', 'cpf'].some(f => before[f] !== after[f]);
    const ativoToFalse    = before.ativo !== false && after.ativo === false;
    const ativoToTrue     = before.ativo === false && after.ativo !== false;

    if (!dataChanged && !ativoToFalse && !ativoToTrue) return null;

    const uid = context.params.uid;

    try {
      const apiKey = await getAsaasApiKey();

      // Sincroniza dados cadastrais quando nome/telefone/CPF (ou os do responsável, se mirim) mudam
      if (dataChanged) {
        const resp = await fetch(`${ASAAS_BASE_URL}/customers/${after.asaasId}`, {
          method: 'POST',
          headers: { access_token: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name:        isMirim
              ? `${(after.nome || '').trim()} (Mirim) — resp. ${(after.responsavelNome || '').trim()}`
              : (after.nome || '').trim(),
            cpfCnpj:     ((isMirim ? after.responsavelCpf : after.cpf) || '').replace(/\D/g, ''),
            mobilePhone: formatPhoneForAsaas(isMirim ? after.responsavelTelefone : after.telefone),
          }),
        });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};
        if (!resp.ok) throw new Error(data.errors?.[0]?.description || `HTTP ${resp.status}`);
        console.log(`onAssociadoAtualizado: uid=${uid} dados sincronizados`);
      }

      // Pausa ou reativa assinatura Asaas quando ativo muda
      if ((ativoToFalse || ativoToTrue) && after.asaasSubscriptionId) {
        const newStatus = ativoToFalse ? 'INACTIVE' : 'ACTIVE';
        const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions/${after.asaasSubscriptionId}`, {
          method: 'POST',
          headers: { access_token: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });
        const subText = await subResp.text();
        const subData = subText ? JSON.parse(subText) : {};
        if (!subResp.ok) throw new Error(subData.errors?.[0]?.description || `HTTP ${subResp.status}`);
        console.log(`onAssociadoAtualizado: uid=${uid} assinatura ${newStatus}`);
      }

      // Desativação: cancela tudo que está em aberto no Asaas e desliga notificações — sem
      // isso, o associado inativo continua vencendo cobrança e recebendo aviso de cobrança.
      if (ativoToFalse && after.asaasId) {
        const { found, canceled } = await cancelOpenPayments(uid, after.asaasId, apiKey);
        console.log(`onAssociadoAtualizado: uid=${uid} cobranças canceladas ${canceled}/${found}`);
        await setCustomerNotificationsEnabled(after.asaasId, apiKey, false);
        console.log(`onAssociadoAtualizado: uid=${uid} notificações desativadas`);
      }

      // Reativação: religa notificações e gera uma cobrança avulsa imediata — a assinatura só
      // gerará a próxima cobrança no ciclo natural dela, que pode estar meses à frente.
      if (ativoToTrue && after.asaasId) {
        await syncCustomerNotifications(after.asaasId, apiKey);
        console.log(`onAssociadoAtualizado: uid=${uid} notificações reativadas`);
        const charge = await createImmediateChargeOnReactivation(uid, after, apiKey);
        console.log(`onAssociadoAtualizado: uid=${uid} cobrança de reativação criada payment=${charge.id}`);
      }

      if (ativoToFalse || ativoToTrue) {
        await change.after.ref.update({
          'asaasSync.lastLifecycleAction': ativoToFalse ? 'deactivate' : 'reactivate',
          'asaasSync.lastLifecycleAt':     admin.firestore.FieldValue.serverTimestamp(),
          'asaasSync.lastLifecycleResult': 'ok',
          'asaasSync.lastLifecycleError':  null,
        }).catch(e => console.warn('onAssociadoAtualizado: falha ao gravar asaasSync (ok)', uid, e.message));
      }
    } catch (err) {
      console.error('onAssociadoAtualizado error:', uid, err.message);
      if (ativoToFalse || ativoToTrue) {
        // Best-effort: expõe a falha na aba Auditoria / pílula "Sem sinc. Asaas" do painel —
        // sem isso, o associado aparece desativado/reativado no clube enquanto o Asaas diverge
        // silenciosamente (foi o que produziu associados inativos com cobrança ainda aberta).
        await change.after.ref.update({
          'asaasSync.lastLifecycleAction': ativoToFalse ? 'deactivate' : 'reactivate',
          'asaasSync.lastLifecycleAt':     admin.firestore.FieldValue.serverTimestamp(),
          'asaasSync.lastLifecycleResult': 'error',
          'asaasSync.lastLifecycleError':  err.message,
        }).catch(e => console.warn('onAssociadoAtualizado: falha ao gravar asaasSync (error)', uid, e.message));
      }
    }

    return null;
  });

// Trigger: quando fatura é ATUALIZADA para status pago → baixa cobrança no Asaas
exports.onInvoicePaid = functions.firestore
  .document('users/{uid}/financeInvoices/{invoiceId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    const beforeStatus = String(before.status || '').toLowerCase();
    const afterStatus  = String(after.status  || '').toLowerCase();

    // Só age quando muda PARA pago
    if (['pago', 'paga', 'paid'].includes(beforeStatus)) return null;
    if (!['pago', 'paga', 'paid'].includes(afterStatus)) return null;

    try {
      await syncManualPaymentToAsaas(context.params.uid, change.after.ref, after);
    } catch (err) {
      console.error('onInvoicePaid error:', context.params.uid, context.params.invoiceId, err.message);
    }

    return null;
  });

// Trigger: quando fatura é CRIADA já como paga (pagamento imediato pelo admin) → baixa no Asaas
exports.onInvoiceCreatedPaid = functions.firestore
  .document('users/{uid}/financeInvoices/{invoiceId}')
  .onCreate(async (snap, context) => {
    const data   = snap.data();
    const status = String(data.status || '').toLowerCase();

    if (!['pago', 'paga', 'paid'].includes(status)) return null;

    try {
      await syncManualPaymentToAsaas(context.params.uid, snap.ref, data);
    } catch (err) {
      console.error('onInvoiceCreatedPaid error:', context.params.uid, context.params.invoiceId, err.message);
    }

    return null;
  });

/* =======================================================================
   getAsaasPaymentLink — retorna o link de pagamento da fatura aberta do associado
   ======================================================================= */
exports.getAsaasPaymentLink = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

  const uid = context.auth.uid;
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Usuário não encontrado.');

  const user = userSnap.data();
  if (!user.asaasSubscriptionId)
    throw new functions.https.HttpsError('not-found', 'Assinatura não configurada. Entre em contato com o clube.');

  const apiKey = await getAsaasApiKey();

  for (const st of ['PENDING', 'OVERDUE']) {
    const resp = await fetch(
      `${ASAAS_BASE_URL}/payments?subscription=${user.asaasSubscriptionId}&status=${st}&limit=1&sort=dueDate&order=asc`,
      { headers: { 'access_token': apiKey } }
    );
    const result = await resp.json();
    if (result.data?.length) {
      const p = result.data[0];
      return {
        invoiceUrl:     p.invoiceUrl,
        asaasPaymentId: p.id,
        dueDate:        p.dueDate,
        value:          p.value,
        status:         p.status,
      };
    }
  }

  return { emDia: true };
});

/* =======================================================================
   Auto-cancelamento e reativação de assinatura pelo próprio associado
   ======================================================================= */

// Envia um e-mail curto de aviso aos admins (mesmo transporter/credenciais de
// sendDailyPaymentReport). Nunca lança — falha de e-mail não pode impedir o
// cancelamento/reativação em si.
async function notifyAdminsByEmail(subject, bodyHtml) {
  // Timeout curto proposital: se o SMTP estiver lento/com credenciais inválidas, isso não pode
  // atrasar (nem, em navegadores/proxies com timeout agressivo, derrubar do lado do cliente) a
  // resposta de cancelMySubscription/reactivateMySubscription — o e-mail é só um aviso, não faz
  // parte do resultado que o associado está esperando.
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  const send = (async () => {
    try {
      const emailUser = await getSecret('projects/clubecavalobonfim/secrets/email-user/versions/latest');
      const emailPassword = await getSecret('projects/clubecavalobonfim/secrets/email-password/versions/latest');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPassword },
      });
      await transporter.sendMail({
        from: '"Clube do Cavalo Bonfim MG" <contato@clubedocavalobonfim.com.br>',
        to: 'waldiney.serafim@gmail.com, mpmarquesnutri@gmail.com',
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
// Importante: NÃO grava ativo:false. login.html (routeAuthenticatedUser/deriveStatus) e
// firebase.js (getUserStatus) tratam ativo:false como "conta desativada" e bloqueiam o acesso
// já no próximo login — isso é o comportamento certo para desativação pelo admin (justa causa,
// desligamento imediato), mas o requisito aqui é o oposto: o associado deve continuar acessando
// o portal e os benefícios normalmente até finance/summary.activeUntil, só parando de ser
// cobrado dali pra frente. Por isso esta function fala direto com o Asaas — pausa a assinatura
// e cancela cobranças em aberto reaproveitando as mesmas rotinas que onAssociadoAtualizado usa
// na desativação pelo admin (cancelOpenPayments/setCustomerNotificationsEnabled) — e grava só um
// marcador dedicado (assinaturaCanceladaPeloAssociado). Quando activeUntil vencer, quem realmente
// tira o acesso é o bloqueio de inadimplência que já existe em pg_associado.html.
exports.cancelMySubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

  const uid = context.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Usuário não encontrado.');

  const userData = userSnap.data();

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
    const apiKey = await getAsaasApiKey();

    if (userData.asaasSubscriptionId) {
      const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions/${userData.asaasSubscriptionId}`, {
        method: 'POST',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'INACTIVE' }),
      });
      const subText = await subResp.text();
      const subData = subText ? JSON.parse(subText) : {};
      if (!subResp.ok) throw new Error(subData.errors?.[0]?.description || `HTTP ${subResp.status}`);
    }

    if (userData.asaasId) {
      await cancelOpenPayments(uid, userData.asaasId, apiKey);
      await setCustomerNotificationsEnabled(userData.asaasId, apiKey, false);
    }
  } catch (err) {
    console.error('cancelMySubscription: falha ao cancelar no Asaas', uid, err.message);
    throw new functions.https.HttpsError('internal', 'Não foi possível cancelar sua assinatura agora. Tente novamente ou contate o clube.');
  }

  await userRef.update({
    assinaturaCanceladaEm: admin.firestore.FieldValue.serverTimestamp(),
    assinaturaCanceladaPeloAssociado: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let activeUntilStr = '—';
  try {
    await updateFinanceSummary(uid);
    const summarySnap = await userRef.collection('finance').doc('summary').get();
    const activeUntil = summarySnap.exists ? summarySnap.data().activeUntil : null;
    if (activeUntil) activeUntilStr = formatDateBR(activeUntil.toDate ? activeUntil.toDate() : new Date(activeUntil));
  } catch (_) { /* opcional */ }

  await notifyAdminsByEmail(
    `CCBMG - Associado cancelou a própria assinatura: ${userData.nome || uid}`,
    `<p>O associado <strong>${escHtml(userData.nome || '—')}</strong> (CPF ${escHtml(userData.cpf || '—')}, tel. ${escHtml(userData.telefone || '—')}) cancelou a própria assinatura pelo portal.</p>
     <p>Plano: ${escHtml(userData.planType || '—')}<br>Acesso garantido até: ${escHtml(activeUntilStr)}</p>`
  );

  console.log(`cancelMySubscription: uid=${uid} cancelado pelo próprio associado`);
  return { success: true, activeUntil: activeUntilStr };
});

// Callable: o próprio associado reativa uma assinatura que ele mesmo cancelou (reverte
// exatamente o que cancelMySubscription fez, reaproveitando as mesmas rotinas que
// onAssociadoAtualizado usa na reativação pelo admin: syncCustomerNotifications +
// createImmediateChargeOnReactivation). Bloqueado se a conta foi desativada pelo admin
// (ativo:false é um mecanismo totalmente separado — ver comentário de cancelMySubscription).
exports.reactivateMySubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

  const uid = context.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Usuário não encontrado.');

  const userData = userSnap.data();

  if (userData.ativo === false) {
    throw new functions.https.HttpsError('permission-denied', 'Sua conta foi desativada pela administração. Entre em contato com o clube para reativar.');
  }
  if (userData.assinaturaCanceladaPeloAssociado !== true) {
    throw new functions.https.HttpsError('failed-precondition', 'Não há cancelamento para reverter — sua assinatura já está ativa.');
  }

  try {
    const apiKey = await getAsaasApiKey();

    if (userData.asaasSubscriptionId) {
      const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions/${userData.asaasSubscriptionId}`, {
        method: 'POST',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE' }),
      });
      const subText = await subResp.text();
      const subData = subText ? JSON.parse(subText) : {};
      if (!subResp.ok) throw new Error(subData.errors?.[0]?.description || `HTTP ${subResp.status}`);
    }

    if (userData.asaasId) {
      await syncCustomerNotifications(userData.asaasId, apiKey);
      await createImmediateChargeOnReactivation(uid, userData, apiKey);
    }
  } catch (err) {
    console.error('reactivateMySubscription: falha ao reativar no Asaas', uid, err.message);
    throw new functions.https.HttpsError('internal', 'Não foi possível reativar sua assinatura agora. Tente novamente ou contate o clube.');
  }

  await userRef.update({
    assinaturaCanceladaEm: admin.firestore.FieldValue.delete(),
    assinaturaCanceladaPeloAssociado: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try { await updateFinanceSummary(uid); } catch (_) { /* opcional */ }

  await notifyAdminsByEmail(
    `CCBMG - Associado reativou a própria assinatura: ${userData.nome || uid}`,
    `<p>O associado <strong>${escHtml(userData.nome || '—')}</strong> (CPF ${escHtml(userData.cpf || '—')}) reativou a própria assinatura pelo portal.</p>`
  );

  console.log(`reactivateMySubscription: uid=${uid} reativado pelo próprio associado`);
  return { success: true };
});

/* =======================================================================
   CENTRAL FINANCEIRA — sincronização sob demanda + ações rápidas do painel admin
   ======================================================================= */

// Busca assinatura + pagamentos recentes ao vivo no Asaas, reconcilia financeInvoices/finance/summary
// e grava o resultado em asaasSync. Usado tanto pela callable interativa (manual=true) quanto pela
// reconciliação diária agendada (manual=false) — única fonte dessa rotina para as duas não divergirem.
async function syncOneAssociado(uid, { manual = false } = {}) {
  const userRef = db.collection('users').doc(uid);

  try {
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error('Associado não encontrado.');
    const userData = userSnap.data();
    if (!userData.asaasId || !userData.asaasSubscriptionId) {
      throw new Error('Associado sem assinatura Asaas configurada.');
    }

    const apiKey = await getAsaasApiKey();

    const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions/${userData.asaasSubscriptionId}`, {
      headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    });
    const subText = await subResp.text();
    const subData = subText ? JSON.parse(subText) : {};
    if (!subResp.ok) throw new Error(subData.errors?.[0]?.description || `HTTP ${subResp.status}`);

    // Reconcilia só os pagamentos já efetivamente recebidos — mesmo escopo do asaasWebhook,
    // nunca mexe em cobranças pendentes/vencidas (essas continuam responsabilidade do Asaas).
    const paymentsResp = await fetch(
      `${ASAAS_BASE_URL}/payments?subscription=${userData.asaasSubscriptionId}&limit=10&sort=dueDate&order=desc`,
      { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
    );
    const paymentsText = await paymentsResp.text();
    const paymentsData = paymentsText ? JSON.parse(paymentsText) : {};
    const payments = paymentsData.data || [];

    for (const p of payments) {
      if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(p.status)) {
        await upsertInvoiceFromAsaasPayment(uid, p);
      }
    }

    await updateFinanceSummary(uid);

    // Estado da automação de notificações POR CANAL (WhatsApp/SMS/E-mail) — alimenta o indicador
    // na Central de Associados. Best-effort: se a leitura falhar, não interrompe a sincronização
    // nem apaga o valor anterior (notifSummary fica null e não é gravado). Um canal é considerado
    // habilitado só se estiver ligado em TODOS os eventos aplicáveis (WhatsApp não é suportado em
    // SEND_LINHA_DIGITAVEL, então esse evento é ignorado no cálculo do WhatsApp).
    let notifSummary = null;
    try {
      const notifResp = await fetch(
        `${ASAAS_BASE_URL}/customers/${userData.asaasId}/notifications`,
        { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
      );
      const notifText = await notifResp.text();
      const notifData = notifText ? JSON.parse(notifText) : {};
      if (notifResp.ok) {
        const notifs = notifData.data || [];
        const whatsApplicable = notifs.filter(n => !WHATSAPP_UNSUPPORTED_EVENTS.has(n.event));
        notifSummary = {
          configured: notifs.length > 0,
          whatsapp:   whatsApplicable.length > 0 && whatsApplicable.every(n => n.whatsappEnabledForCustomer === true),
          sms:        notifs.length > 0 && notifs.every(n => n.smsEnabledForCustomer === true),
          email:      notifs.length > 0 && notifs.every(n => n.emailEnabledForCustomer === true),
          checkedAt:  admin.firestore.FieldValue.serverTimestamp(),
        };
      }
    } catch (e) {
      console.warn('syncOneAssociado: falha ao ler notificações', uid, e.message);
    }

    // Status da assinatura não é gravado por nenhum outro fluxo — só aqui, sob demanda
    await userRef.collection('finance').doc('summary').set({
      subscriptionStatus:      subData.status || null,
      subscriptionValue:       subData.value ?? null,
      subscriptionCycle:       subData.cycle || null,
      subscriptionBillingType: subData.billingType || null,
      subscriptionNextDueDate: subData.nextDueDate || null,
      ...(notifSummary ? { notif: notifSummary } : {}),
    }, { merge: true });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const syncPatch = {
      'asaasSync.lastSyncedAt':   now,
      'asaasSync.lastSyncResult': 'ok',
      'asaasSync.lastSyncError':  null,
    };
    if (manual) {
      syncPatch['asaasSync.lastApiCheckAt']     = now;
      syncPatch['asaasSync.lastApiCheckStatus'] = 'ok';
    }
    await userRef.update(syncPatch);

    return { ok: true };
  } catch (err) {
    const now = admin.firestore.FieldValue.serverTimestamp();
    const syncPatch = {
      'asaasSync.lastSyncedAt':   now,
      'asaasSync.lastSyncResult': 'error',
      'asaasSync.lastSyncError':  err.message,
    };
    if (manual) {
      syncPatch['asaasSync.lastApiCheckAt']     = now;
      syncPatch['asaasSync.lastApiCheckStatus'] = 'error';
    }
    await userRef.update(syncPatch).catch(() => {});
    throw err;
  }
}

// Callable: "Atualizar dados" no painel — consulta o Asaas ao vivo para 1 associado.
// Requer role admin ou master.
exports.asaasSyncAssociado = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
  }
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.data()?.role);
  if (!['admin', 'master'].includes(callerRole)) {
    throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
  }

  const uid = data?.uid;
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid é obrigatório.');

  try {
    await syncOneAssociado(uid, { manual: true });
  } catch (err) {
    throw new functions.https.HttpsError('internal', err.message || 'Falha ao consultar o Asaas.');
  }

  const summarySnap = await db.collection('users').doc(uid).collection('finance').doc('summary').get();
  return { ok: true, summary: summarySnap.exists ? summarySnap.data() : null };
});

// Callable: "Gerar cobrança" no painel — cria uma cobrança avulsa para o associado (fora do ciclo da assinatura).
// Requer role admin ou master.
exports.asaasCreatePayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
  }
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.data()?.role);
  if (!['admin', 'master'].includes(callerRole)) {
    throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
  }

  const uid = data?.uid;
  const value = Number(data?.value);
  const description = String(data?.description || '').trim();
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid é obrigatório.');
  if (!value || value <= 0) throw new functions.https.HttpsError('invalid-argument', 'Valor inválido.');

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Associado não encontrado.');
  const userData = userSnap.data();
  if (!userData.asaasId) throw new functions.https.HttpsError('failed-precondition', 'Associado sem cadastro no Asaas.');

  const apiKey = await getAsaasApiKey();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 5);

  const payResp = await fetch(`${ASAAS_BASE_URL}/payments`, {
    method: 'POST',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer:          userData.asaasId,
      billingType:       'UNDEFINED',
      value,
      dueDate:           dueDate.toISOString().slice(0, 10),
      description:       description || 'Cobrança avulsa CCBMG',
      externalReference: uid,
    }),
  });
  const payData = await payResp.json();
  if (!payResp.ok || !payData.id) {
    throw new functions.https.HttpsError('internal', payData.errors?.[0]?.description || 'Falha ao gerar cobrança no Asaas.');
  }

  console.log(`asaasCreatePayment: uid=${uid} payment=${payData.id} value=${value}`);
  return { asaasPaymentId: payData.id, invoiceUrl: payData.invoiceUrl, dueDate: payData.dueDate };
});

// Callable: "Cancelar cobrança" no painel.
// Requer role admin ou master.
exports.asaasCancelPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
  }
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.data()?.role);
  if (!['admin', 'master'].includes(callerRole)) {
    throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
  }

  const uid = data?.uid;
  const asaasPaymentId = data?.asaasPaymentId;
  if (!uid || !asaasPaymentId) {
    throw new functions.https.HttpsError('invalid-argument', 'uid e asaasPaymentId são obrigatórios.');
  }

  const apiKey = await getAsaasApiKey();
  const delResp = await fetch(`${ASAAS_BASE_URL}/payments/${asaasPaymentId}`, {
    method: 'DELETE',
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
  });
  const delData = await delResp.json();
  if (!delResp.ok || delData.deleted !== true) {
    throw new functions.https.HttpsError('internal', delData.errors?.[0]?.description || 'Falha ao cancelar cobrança no Asaas.');
  }

  // Reflete localmente a cobrança cancelada, se existir uma financeInvoice correspondente
  const invSnap = await db.collection('users').doc(uid).collection('financeInvoices')
    .where('asaasPaymentId', '==', asaasPaymentId).limit(1).get();
  if (!invSnap.empty) {
    await invSnap.docs[0].ref.update({
      status: 'cancelado',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  console.log(`asaasCancelPayment: uid=${uid} payment=${asaasPaymentId} cancelado`);
  return { ok: true };
});

// Callable: "Consultar cobrança" no painel — status ao vivo, somente leitura.
// Requer role admin ou master.
exports.asaasGetPaymentStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
  }
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.data()?.role);
  if (!['admin', 'master'].includes(callerRole)) {
    throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
  }

  const asaasPaymentId = data?.asaasPaymentId;
  if (!asaasPaymentId) throw new functions.https.HttpsError('invalid-argument', 'asaasPaymentId é obrigatório.');

  const apiKey = await getAsaasApiKey();
  const resp = await fetch(`${ASAAS_BASE_URL}/payments/${asaasPaymentId}`, {
    headers: { access_token: apiKey, 'Content-Type': 'application/json' },
  });
  const result = await resp.json();
  if (!resp.ok) {
    throw new functions.https.HttpsError('internal', result.errors?.[0]?.description || 'Falha ao consultar cobrança no Asaas.');
  }

  return {
    status:        result.status,
    value:         result.value,
    dueDate:       result.dueDate,
    paymentDate:   result.paymentDate || result.confirmedDate || null,
    billingType:   result.billingType,
    invoiceUrl:    result.invoiceUrl,
    invoiceNumber: result.invoiceNumber,
  };
});

// Agendada: reconciliação diária de madrugada — autocorrige o Firestore caso algum webhook tenha falhado.
// Escopo estritamente de leitura/reconciliação: nunca cria/cancela cobrança, nunca cria assinatura,
// nunca altera valor ou data de vencimento. Só chama o mesmo syncOneAssociado usado pelo botão "Atualizar dados".
exports.asaasReconciliationDaily = functions
  // Percorre a base inteira chamando a API do Asaas por associado (assinatura + pagamentos +
  // notificações) — no timeout padrão de 60s a rotina morria no meio, deixando parte da base
  // sem reconciliar e sem ninguém perceber (roda de madrugada). 540s é o mesmo teto já usado
  // pelas outras rotinas em lote deste arquivo.
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .pubsub.schedule('0 4 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    // Mesmo padrão de syncAllAssociadosToAsaas/auditAsaasSync: 1 leitura da coleção + filtro em memória,
    // evita depender de um índice composto novo.
    const usersSnap = await db.collection('users').get();
    const results = { synced: 0, errors: [] };

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      if (!userData.asaasId || !userData.asaasSubscriptionId || userData.ativo === false) continue;

      try {
        await syncOneAssociado(userDoc.id, { manual: false });
        results.synced++;
      } catch (err) {
        console.error('asaasReconciliationDaily error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, error: err.message });
      }

      // Pausa para respeitar rate limits do Asaas
      await new Promise(r => setTimeout(r, 250));
    }

    console.log('asaasReconciliationDaily result:', results);
    return null;
  });

/* =======================================================================
   WEBHOOK ASAAS → FIREBASE
   Configurar no Asaas: Configurações → Integrações → Webhook
   URL: https://us-central1-clubecavalobonfim.cloudfunctions.net/asaasWebhook
   ======================================================================= */
exports.asaasWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Valida token de autenticação do Asaas
  try {
    const expectedToken = await getSecret(ASAAS_WEBHOOK_TOKEN);
    const receivedToken = req.headers['asaas-access-token'];
    if (!receivedToken || receivedToken !== expectedToken) {
      console.warn('asaasWebhook: token inválido ou ausente');
      return res.status(401).send('Unauthorized');
    }
  } catch (err) {
    console.error('asaasWebhook: erro ao validar token', err.message);
    return res.status(500).send('Error');
  }

  const { event, payment } = req.body || {};

  // Só processa pagamentos confirmados
  if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) {
    return res.status(200).send('OK');
  }
  if (!payment?.id || !payment?.subscription) {
    return res.status(200).send('OK');
  }

  try {
    const apiKey = await getAsaasApiKey();

    // Verifica o pagamento diretamente no Asaas (evita fraudes)
    const verifyResp = await fetch(`${ASAAS_BASE_URL}/payments/${payment.id}`, {
      headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    });
    const verifyText = await verifyResp.text();
    const verifyData = verifyText ? JSON.parse(verifyText) : {};

    if (!verifyResp.ok || !['RECEIVED', 'CONFIRMED'].includes(verifyData.status)) {
      console.warn('asaasWebhook: pagamento não confirmado no Asaas', payment.id, verifyData.status);
      return res.status(200).send('OK');
    }

    // Busca a assinatura para obter o externalReference (UID do Firebase)
    const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions/${payment.subscription}`, {
      headers: { access_token: apiKey, 'Content-Type': 'application/json' },
    });
    const subText = await subResp.text();
    const subData = subText ? JSON.parse(subText) : {};

    const uid = subData.externalReference;
    if (!uid) {
      console.warn('asaasWebhook: assinatura sem externalReference', payment.subscription);
      return res.status(200).send('OK');
    }

    // Marca que recebemos um webhook para este uid (aba Auditoria do painel admin) — best-effort
    await db.collection('users').doc(uid).update({
      'asaasSync.lastWebhookAt':    admin.firestore.FieldValue.serverTimestamp(),
      'asaasSync.lastWebhookEvent': event,
    }).catch(err => console.warn('asaasWebhook: falha ao gravar asaasSync', uid, err.message));

    const result = await upsertInvoiceFromAsaasPayment(uid, verifyData);

    if (result.action === 'skipped') {
      console.warn('asaasWebhook:', result.reason, uid);
      return res.status(200).send('OK');
    }
    console.log(`asaasWebhook: fatura ${result.action} uid=${uid} invoiceId=${result.invoiceId} payment=${payment.id}`);

    // Atualiza finance/summary com os dados mais recentes
    await updateFinanceSummary(uid);

    return res.status(200).send('OK');
  } catch (err) {
    console.error('asaasWebhook error:', err.message);
    return res.status(500).send('Error');
  }
});

// Redefine a senha de um associado. Requer role master.
exports.resetUserPassword = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
  }

  const callerSnap = await admin.firestore().collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.exists ? callerSnap.data().role : '');
  if (callerRole !== 'master') {
    throw new functions.https.HttpsError('permission-denied', 'Apenas o perfil master pode redefinir senhas.');
  }

  const { targetUid, newPassword } = data;
  if (!targetUid || !newPassword || newPassword.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'UID e senha (mínimo 8 caracteres) são obrigatórios.');
  }

  // Impede que o master redefina a própria senha por esta rota
  if (targetUid === context.auth.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Use o formulário de troca de senha para alterar sua própria senha.');
  }

  const targetSnap = await admin.firestore().collection('users').doc(targetUid).get();
  if (targetSnap.exists && targetSnap.data().categoriaAssociado === 'mirim') {
    throw new functions.https.HttpsError('failed-precondition', 'Associado Mirim não tem conta de acesso — não há senha para redefinir.');
  }

  await admin.auth().updateUser(targetUid, { password: newPassword });
  await admin.firestore().collection('users').doc(targetUid).update({
    primeiroAcesso: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`resetUserPassword: senha redefinida para uid=${targetUid} por master uid=${context.auth.uid}`);
  return { success: true };
});

// Exclui definitivamente um associado: cobrança/cliente no Asaas, subcoleções do
// Firestore, o documento em users/{uid} e a conta no Firebase Auth. Irreversível —
// restrito ao perfil master.
exports.deleteAssociado = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
  }

  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.exists ? callerSnap.data().role : '');
  if (callerRole !== 'master') {
    throw new functions.https.HttpsError('permission-denied', 'Apenas o perfil master pode excluir associados.');
  }

  const targetUid = data?.uid;
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'uid é obrigatório.');
  }
  if (targetUid === context.auth.uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Não é possível excluir a própria conta por esta rota.');
  }

  const userRef = db.collection('users').doc(targetUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Associado não encontrado no Firestore.');
  }
  const userData = userSnap.data();

  // Cancela cliente/assinatura no Asaas antes de apagar o registro local (não bloqueia a exclusão em caso de falha)
  try {
    const apiKey = await getAsaasApiKey();
    if (userData.asaasSubscriptionId) {
      await fetch(`${ASAAS_BASE_URL}/subscriptions/${userData.asaasSubscriptionId}`, {
        method: 'DELETE',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
      });
    }
    if (userData.asaasId) {
      await fetch(`${ASAAS_BASE_URL}/customers/${userData.asaasId}`, {
        method: 'DELETE',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    console.warn(`deleteAssociado: falha ao remover uid=${targetUid} do Asaas (prosseguindo com exclusão local): ${e.message}`);
  }

  // Apaga subcoleções (financeInvoices, finance/summary) e o documento do usuário
  const invSnap = await userRef.collection('financeInvoices').get();
  const batch = db.batch();
  invSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(userRef.collection('finance').doc('summary'));
  batch.delete(userRef);
  await batch.commit();

  // Apaga a conta no Firebase Auth, se existir
  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      throw new functions.https.HttpsError('internal', `Registro do Firestore removido, mas falhou ao excluir conta de autenticação: ${e.message}`);
    }
  }

  console.log(`deleteAssociado: uid=${targetUid} excluído por master uid=${context.auth.uid}`);
  return { success: true };
});


/* ================================================================
   MÓDULO DE LEILÕES
   ================================================================ */

// ---- placeBid (onCall) ----
// Lance atômico com Firestore Transaction: valida +2%, anti-sniper, inadimplente, dono
exports.placeBid = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Faça login para dar lances.');

  const { lotId, amount } = data;
  if (!lotId || typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Dados inválidos.');
  }

  const bidderUid  = context.auth.uid;
  const lotRef     = db.collection('auctionLots').doc(lotId);
  const bidsRef    = lotRef.collection('bids');
  const bidderRef  = db.collection('users').doc(bidderUid);

  // Verificar inadimplência antes da transação (leitura rápida)
  const bidderSnap = await bidderRef.get();
  if (bidderSnap.exists && bidderSnap.data().inadimplenteLeilao === true) {
    throw new functions.https.HttpsError('permission-denied', 'Sua conta está bloqueada por inadimplência.');
  }

  const result = await db.runTransaction(async (tx) => {
    const lotSnap = await tx.get(lotRef);
    if (!lotSnap.exists) throw new functions.https.HttpsError('not-found', 'Lote não encontrado.');

    const lot = lotSnap.data();

    if (lot.status !== 'publicado') {
      throw new functions.https.HttpsError('failed-precondition', 'Este lote não está ativo.');
    }

    const now     = Date.now();
    const endMs   = lot.endTime?.toMillis?.() ?? 0;
    if (endMs && now > endMs) {
      throw new functions.https.HttpsError('failed-precondition', 'O leilão deste lote já encerrou.');
    }

    if (lot.sellerUid === bidderUid) {
      throw new functions.https.HttpsError('permission-denied', 'Você não pode dar lances em seu próprio lote.');
    }

    // Calcular lance mínimo: primeiro lance usa initialBid*1.02; demais usam lastBid*1.02
    const base    = (lot.lastBid && lot.lastBid > 0) ? lot.lastBid : lot.initialBid;
    const minBid  = Math.ceil(base * 1.02 * 100) / 100;
    if (amount < minBid) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `Lance mínimo: R$ ${minBid.toFixed(2).replace('.',',')}. Valor informado: R$ ${amount.toFixed(2).replace('.',',')}.`
      );
    }

    // Anti-sniper: se lance nos últimos 2 minutos, prolonga 2 minutos
    let newEndTime = lot.endTime;
    if (endMs && (endMs - now) < 120000) {
      newEndTime = new admin.firestore.Timestamp.fromMillis(now + 120000);
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
    const now = admin.firestore.Timestamp.now();
    const snap = await db.collection('auctionLots')
      .where('status', '==', 'publicado')
      .where('endTime', '<=', now)
      .get();

    if (snap.empty) return null;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { status: 'encerrado', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await batch.commit();

    // Criar auctionSales para cada lote encerrado com lances
    for (const doc of snap.docs) {
      const lot = doc.data();
      if (!lot.lastBid || !lot.lastBidderUid) continue; // sem lances: só encerra

      const existingSale = await db.collection('auctionSales')
        .where('lotId', '==', doc.id).limit(1).get();
      if (!existingSale.empty) continue; // já criou

      const finalAmount       = lot.lastBid;
      const commissionClube   = Math.round(finalAmount * 0.05 * 100) / 100;
      const commissionSistema = Math.round(finalAmount * 0.05 * 100) / 100;
      const commissionTotal   = Math.round((commissionClube + commissionSistema) * 100) / 100;
      const netSeller         = Math.round((finalAmount - commissionTotal) * 100) / 100;

      // Buscar dados do comprador e vendedor para desnormalizar
      const buyerSnap  = await db.collection('users').doc(lot.lastBidderUid).get();
      const sellerSnap = await db.collection('users').doc(lot.sellerUid).get();

      await db.collection('auctionSales').add({
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

      // Notificar vencedor e vendedor
      const batch2 = db.batch();
      const notifRef = db.collection('auctionNotifications');
      batch2.set(notifRef.doc(), {
        recipientUid: lot.lastBidderUid,
        type: 'lote_arrematado',
        lotId: doc.id,
        lotTitle: lot.title || '',
        message: `Parabéns! Você arrematou o lote "${lot.title}" por R$ ${finalAmount.toFixed(2).replace('.',',')}. Efetue o pagamento em até 5 dias.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch2.set(notifRef.doc(), {
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
// Gera cobrança avulsa no Asaas para o vencedor do lote
exports.gerarCobrancaLeilao = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

  const { saleId } = data;
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'saleId obrigatório.');

  const saleSnap = await db.collection('auctionSales').doc(saleId).get();
  if (!saleSnap.exists) throw new functions.https.HttpsError('not-found', 'Venda não encontrada.');

  const sale = saleSnap.data();

  // Verificar autorização: apenas admin/master ou partes da venda (vendedor/comprador)
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.exists ? (callerSnap.data().role || '') : '');
  const isAdmin = ['admin', 'master'].includes(callerRole);
  const isParty = context.auth.uid === sale.sellerUid || context.auth.uid === sale.buyerUid;
  if (!isAdmin && !isParty) {
    throw new functions.https.HttpsError('permission-denied', 'Sem permissão para esta operação.');
  }

  if (sale.status !== 'aguardando_pagamento') {
    throw new functions.https.HttpsError('failed-precondition', 'Esta venda não está aguardando pagamento.');
  }

  // Verificar cobrança já gerada
  const existPay = await db.collection('auctionPayments')
    .where('saleId', '==', saleId).limit(1).get();
  if (!existPay.empty) return { paymentId: existPay.docs[0].id, alreadyExists: true };

  const apiKey = await getSecret(ASAAS_SECRET);
  const buyerSnap = await db.collection('users').doc(sale.buyerUid).get();
  const buyer = buyerSnap.exists ? buyerSnap.data() : {};

  // Garantir que o comprador tem cliente no Asaas
  let asaasCustomerId = buyer.asaasId;
  if (!asaasCustomerId) {
    const cResp = await fetch(`${ASAAS_BASE_URL}/customers`, {
      method: 'POST',
      headers: { 'access_token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:              buyer.nome || buyer.email || 'Comprador',
        cpfCnpj:           (buyer.cpf || '').replace(/\D/g,''),
        email:             buyer.email || undefined,
        mobilePhone:       formatPhoneForAsaas(buyer.telefone),
        externalReference: sale.buyerUid,
      }),
    });
    const cData = await cResp.json();
    if (!cData.id) {
      console.error('gerarCobrancaLeilao: falha ao criar cliente Asaas', cData);
      throw new functions.https.HttpsError('internal', 'Falha ao criar cliente no Asaas.');
    }
    asaasCustomerId = cData.id;
    await db.collection('users').doc(sale.buyerUid).update({
      asaasId: asaasCustomerId,
      asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Data de vencimento: 5 dias corridos a partir de hoje
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 5);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const payResp = await fetch(`${ASAAS_BASE_URL}/payments`, {
    method: 'POST',
    headers: { 'access_token': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer:         asaasCustomerId,
      billingType:      'UNDEFINED',
      value:            sale.finalAmount,
      dueDate:          dueDateStr,
      description:      `Arrematação lote: ${sale.lotTitle}`,
      externalReference: saleId,
    }),
  });
  const payData = await payResp.json();
  if (!payData.id) {
    console.error('gerarCobrancaLeilao: falha ao criar cobrança Asaas', payData);
    throw new functions.https.HttpsError('internal', 'Falha ao gerar cobrança no Asaas.');
  }

  const paymentRef = await db.collection('auctionPayments').add({
    saleId,
    buyerUid:       sale.buyerUid,
    lotId:          sale.lotId,
    lotTitle:       sale.lotTitle,
    amount:         sale.finalAmount,
    asaasPaymentId: payData.id,
    asaasInvoiceUrl: payData.invoiceUrl || null,
    status:         'pendente',
    dueDate:        admin.firestore.Timestamp.fromDate(dueDate),
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  return { paymentId: paymentRef.id, invoiceUrl: payData.invoiceUrl };
});

// ---- auctionAsaasWebhook (HTTP público) ----
// Recebe PAYMENT_RECEIVED/CONFIRMED do Asaas para cobranças de leilão
exports.auctionAsaasWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  // Validar token exclusivo do webhook de leilões
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

  // Verificar anti-fraude na API
  const apiKey = await getSecret(ASAAS_SECRET);
  const verResp = await fetch(`${ASAAS_BASE_URL}/payments/${payment.id}`, {
    headers: { 'access_token': apiKey },
  });
  const verData = await verResp.json();
  if (!verData.id || !['RECEIVED','CONFIRMED'].includes(verData.status)) {
    console.warn('auctionAsaasWebhook: pagamento não confirmado na API', verData.status);
    res.status(200).send('ok');
    return;
  }

  const saleId = verData.externalReference;
  if (!saleId) { res.status(200).send('ok'); return; }

  // Idempotência: verificar se já processou este asaasPaymentId
  const existSnap = await db.collection('auctionPayments')
    .where('asaasPaymentId', '==', payment.id).limit(1).get();

  if (!existSnap.empty) {
    const payDoc = existSnap.docs[0];
    if (payDoc.data().status === 'pago') { res.status(200).send('ok'); return; }
    await payDoc.ref.update({
      status: 'pago',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    // Registro não existia ainda
    await db.collection('auctionPayments').add({
      saleId,
      asaasPaymentId: payment.id,
      amount:         verData.value,
      status:         'pago',
      paidAt:         admin.firestore.FieldValue.serverTimestamp(),
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Atualizar auctionSales para pago
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
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = mapRoleServer(callerSnap.exists ? callerSnap.data().role : '');
  if (!['admin','master'].includes(callerRole)) {
    throw new functions.https.HttpsError('permission-denied', 'Acesso negado.');
  }

  const { saleId } = data;
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'saleId obrigatório.');

  const saleSnap = await db.collection('auctionSales').doc(saleId).get();
  if (!saleSnap.exists) throw new functions.https.HttpsError('not-found', 'Venda não encontrada.');

  const sale = saleSnap.data();
  if (sale.status !== 'pago') {
    throw new functions.https.HttpsError('failed-precondition', 'Repasse só pode ser liberado após o pagamento.');
  }

  await db.collection('auctionSales').doc(saleId).update({
    status:      'repasse_liberado',
    releasedBy:  context.auth.uid,
    releasedAt:  admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notificar vendedor
  await db.collection('auctionNotifications').add({
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
// Cria cliente Asaas para ParticipanteLeilao vencedor, se ainda não tiver asaasId
exports.onSaleCreated = functions.firestore
  .document('auctionSales/{saleId}')
  .onCreate(async (snap) => {
    const sale = snap.data();
    if (!sale.buyerUid) return null;

    const buyerRef  = db.collection('users').doc(sale.buyerUid);
    const buyerSnap = await buyerRef.get();
    if (!buyerSnap.exists) return null;

    const buyer = buyerSnap.data();
    if (buyer.asaasId) return null; // já tem cliente no Asaas

    const apiKey = await getSecret(ASAAS_SECRET);
    const resp = await fetch(`${ASAAS_BASE_URL}/customers`, {
      method: 'POST',
      headers: { 'access_token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:              buyer.nome || buyer.email || 'Comprador',
        cpfCnpj:           (buyer.cpf || '').replace(/\D/g,''),
        email:             buyer.email || undefined,
        mobilePhone:       formatPhoneForAsaas(buyer.telefone),
        externalReference: sale.buyerUid,
      }),
    });
    const data = await resp.json();
    if (!data.id) {
      console.error('onSaleCreated: falha ao criar cliente Asaas', data);
      return null;
    }

    await buyerRef.update({
      asaasId:       data.id,
      asaasSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`onSaleCreated: cliente Asaas criado para ${sale.buyerUid} → ${data.id}`);
    return null;
  });

// ---- verificarInadimplentesDiarios (scheduled, diário às 09:00 BRT) ----
// Bloqueia compradores que não pagaram a cobrança de leilão no prazo
exports.verificarInadimplentesDiarios = functions.pubsub.schedule('0 9 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    // Cobranças pendentes com dueDate vencida
    const snap = await db.collection('auctionPayments')
      .where('status', '==', 'pendente')
      .where('dueDate', '<', now)
      .get();

    if (snap.empty) return null;

    const batch = db.batch();
    const uidsToBlock = new Set();

    for (const doc of snap.docs) {
      const pay = doc.data();
      batch.update(doc.ref, { status: 'vencido', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (pay.buyerUid) uidsToBlock.add(pay.buyerUid);

      // Atualizar sale para cancelado se ainda em aguardando_pagamento
      if (pay.saleId) {
        const saleSnap = await db.collection('auctionSales').doc(pay.saleId).get();
        if (saleSnap.exists && saleSnap.data().status === 'aguardando_pagamento') {
          batch.update(saleSnap.ref, {
            status:    'cancelado',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    await batch.commit();

    for (const uid of uidsToBlock) {
      await db.collection('users').doc(uid).update({
        inadimplenteLeilao: true,
        updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
      });
      // Notificar usuário
      await db.collection('auctionNotifications').add({
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

// ─── VALIDAÇÃO DE CPF ─────────────────────────────────────────────────────────

function validateCPF(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // todos dígitos iguais
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

// Callable: audita CPFs de todos os associados ativos.
// Retorna listas separadas por tipo de problema.
// Requer role admin ou master.
exports.auditCpfs = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const usersSnap = await db.collection('users').get();
    const ausente  = [];   // sem CPF
    const tamanho  = [];   // CPF tem dígitos mas ≠ 11
    const invalido = [];   // 11 dígitos mas dígito verificador errado
    const valido   = [];   // CPF matematicamente correto
    let inativos = 0;
    let naoAssociado = 0;

    for (const docSnap of usersSnap.docs) {
      const u = { uid: docSnap.id, ...docSnap.data() };
      if (u.ativo === false) { inativos++; continue; }
      const role = mapRoleServer(u.role);
      if (role !== 'associado') { naoAssociado++; continue; }

      const cpfRaw = String(u.cpf || '').replace(/\D/g, '');
      const info = { uid: u.uid, nome: u.nome || '—', cpf: cpfRaw || '(vazio)' };

      if (!cpfRaw) {
        ausente.push(info);
      } else if (cpfRaw.length !== 11) {
        tamanho.push({ ...info, digitos: cpfRaw.length });
      } else if (!validateCPF(cpfRaw)) {
        invalido.push(info);
      } else {
        valido.push(u.uid);
      }
    }

    return {
      geradoEm: new Date().toISOString(),
      totais: {
        validos:     valido.length,
        ausentes:    ausente.length,
        tamanhoErrado: tamanho.length,
        invalidos:   invalido.length,
        inativos,
        naoAssociado,
      },
      ausente,
      tamanhoErrado: tamanho,
      invalido,
    };
  });

// ─── AUDITORIA ASAAS ─────────────────────────────────────────────────────────

// Callable: retorna diagnóstico de sincronização entre Firestore e Asaas.
// Verifica quais usuários ativos estão sem asaasId ou sem asaasSubscriptionId.
// Requer role admin ou master.
exports.auditAsaasSync = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Requer autenticação.');
    }
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const callerRole = mapRoleServer(callerSnap.data()?.role);
    if (!['admin', 'master'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', 'Requer perfil admin ou master.');
    }

    const usersSnap = await db.collection('users').get();
    const semAsaasId      = [];
    const semSubscription = [];
    let completos   = 0;
    let inativos    = 0;
    let semCpf      = 0;
    let naoAssociado = 0;

    for (const doc of usersSnap.docs) {
      const u = { uid: doc.id, ...doc.data() };

      if (u.ativo === false) { inativos++; continue; }

      const role = mapRoleServer(u.role);
      if (!['associado'].includes(role)) { naoAssociado++; continue; }

      if (!u.cpf) { semCpf++; continue; }

      const info = {
        uid:    u.uid,
        nome:   u.nome   || '—',
        cpf:    u.cpf,
        planType: u.planType || '—',
        asaasId:           u.asaasId           || null,
        asaasSubscriptionId: u.asaasSubscriptionId || null,
      };

      if (!u.asaasId) {
        semAsaasId.push(info);
      } else if (!u.asaasSubscriptionId) {
        semSubscription.push(info);
      } else {
        completos++;
      }
    }

    return {
      geradoEm:   new Date().toISOString(),
      totais: {
        inativos,
        semCpf,
        naoAssociado,
        semAsaasId:      semAsaasId.length,
        semSubscription: semSubscription.length,
        completos,
      },
      semAsaasId,
      semSubscription,
    };
  });

// ─── INSCRIÇÕES EM EVENTOS ───────────────────────────────────────────────────

/* =======================================================================
   createEventRegistration — inscreve participante em evento (sem auth)
   Validações: evento ativo, prazo, vagas, adimplência, duplicata
   ======================================================================= */
exports.createEventRegistration = functions.https.onCall(async (data, _context) => {
  const { eventoId, cpf, nome, telefone } = data || {};
  const orgId = 'org_bonfim';

  if (!eventoId || !cpf || !nome)
    throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos. Informe evento, CPF e nome.');

  const cpfDigits = String(cpf).replace(/\D/g, '');
  if (cpfDigits.length < 11)
    throw new functions.https.HttpsError('invalid-argument', 'CPF inválido.');

  // Carrega evento
  const eventoSnap = await db.collection('cms_events').doc(eventoId).get();
  if (!eventoSnap.exists || eventoSnap.data().deleted)
    throw new functions.https.HttpsError('not-found', 'Evento não encontrado.');

  const evento = eventoSnap.data();
  if (!evento.permiteInscricao)
    throw new functions.https.HttpsError('failed-precondition', 'Inscrições não habilitadas para este evento.');

  if (!evento.ativo)
    throw new functions.https.HttpsError('failed-precondition', 'Evento inativo.');

  // Verifica prazo de inscrição
  if (evento.dataEncerramento) {
    const deadline = evento.dataEncerramento.toDate ? evento.dataEncerramento.toDate() : new Date(evento.dataEncerramento);
    if (new Date() > deadline)
      throw new functions.https.HttpsError('failed-precondition', 'O prazo de inscrições para este evento encerrou.');
  }

  // Verifica vagas
  if (evento.maxInscritos > 0) {
    const countSnap = await db.collection('eventRegistrations')
      .where('eventoId', '==', eventoId)
      .where('orgId', '==', orgId)
      .where('status', 'in', ['ativo', 'confirmado'])
      .get();
    if (countSnap.size >= evento.maxInscritos)
      throw new functions.https.HttpsError('resource-exhausted', 'Vagas esgotadas para este evento.');
  }

  // Resolução de uid e validação de adimplência
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
    // Evento aberto: tenta resolver uid por CPF (best effort, sem exigir)
    try {
      const userSnap = await db.collection('users')
        .where('cpf', '==', cpfDigits)
        .where('orgId', '==', orgId)
        .limit(1)
        .get();
      if (!userSnap.empty) resolvedUid = userSnap.docs[0].id;
    } catch (_) {}
  }

  // Verifica duplicata
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

  // Gera tokens únicos (Node.js 22 — crypto disponível nativamente)
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
   Requer auth (admin/master/operador/adminView)
   ======================================================================= */
exports.confirmEventCheckin = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário para confirmar check-in.');

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

// ─── SAAS MULTI-TENANT ────────────────────────────────────────────────────────


