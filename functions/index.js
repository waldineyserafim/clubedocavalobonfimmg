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

    return !['pago', 'paga', 'paid'].includes(s);

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
    !['pago', 'paga', 'paid', 'cancelado'].includes(String(i.status || '').toLowerCase())
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

  // Busca cobranças pendentes da assinatura com a mesma dueDate
  const chargesResp = await fetch(
    `${ASAAS_BASE_URL}/payments?subscription=${userData.asaasSubscriptionId}&status=PENDING`,
    { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
  );
  const chargesText = await chargesResp.text();
  const chargesData = chargesText ? JSON.parse(chargesText) : {};

  const charge = (chargesData.data || []).find(c => c.dueDate === dueDateStr);
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

  // Salva asaasPaymentId na fatura para idempotência
  await invoiceRef.update({ asaasPaymentId: charge.id });
  console.log(`syncManualPaymentToAsaas: uid=${uid} charge=${charge.id} marcado como pago no Asaas`);
}

// Busca cliente no Asaas pelo CPF; cria se não existir.
// Retorna { asaasId, action: 'found' | 'created' }
async function findOrCreateAsaasCustomer(apiKey, user) {
  const cpf = (user.cpf || '').replace(/\D/g, '');
  if (!cpf) throw new Error('CPF ausente');

  // 1) Busca pelo CPF
  const searchResp = await fetch(
    `${ASAAS_BASE_URL}/customers?cpfCnpj=${cpf}`,
    { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
  );
  const searchData = await searchResp.json();
  if (searchData.data && searchData.data.length > 0) {
    return { asaasId: searchData.data[0].id, action: 'found' };
  }

  // 2) Cria novo cliente
  const body = {
    name: (user.nome || 'Associado').trim(),
    cpfCnpj: cpf,
    mobilePhone: formatPhoneForAsaas(user.telefone),
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
    if (!userData.cpf || userData.ativo === false) return null;

    try {
      const apiKey  = await getAsaasApiKey();
      const { asaasId, action } = await findOrCreateAsaasCustomer(apiKey, userData);

      const planType    = String(userData.planType || 'mensal').toLowerCase().trim();
      const nextDueDate = getNextDueDate();

      const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
        method: 'POST',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer:          asaasId,
          billingType:       'UNDEFINED',
          value:             PLAN_VALUE[planType] || 30,
          nextDueDate,
          cycle:             PLAN_CYCLE[planType] || 'MONTHLY',
          description:       `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType] || 'Mensal'}`,
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
const PENDING_RESTART_DATE = '2026-06-10';

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
            : PENDING_RESTART_DATE;
        } else {
          nextDueDate = PENDING_RESTART_DATE;
        }

        const subResp = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
          method: 'POST',
          headers: { access_token: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer: userData.asaasId,
            billingType: 'UNDEFINED',
            value: PLAN_VALUE[planType],
            nextDueDate,
            cycle: PLAN_CYCLE[planType],
            description: `Mensalidade CCBMG - Plano ${PLAN_LABEL[planType]}`,
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


// Callable: configura o agendamento das notificações do Asaas para todos os associados
// - 5 dias antes do vencimento (PAYMENT_DUEDATE_WARNING)
// - No dia do vencimento     (PAYMENT_DUEDATE_REACHED)
// - 5 dias após o vencimento  (PAYMENT_OVERDUE)
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

    const apiKey    = await getAsaasApiKey();
    const usersSnap = await db.collection('users').get();
    const results   = { configured: 0, skipped: 0, errors: [] };

    // scheduleOffset: null = não enviar o campo (PAYMENT_DUEDATE_REACHED não aceita dias)
    const NOTIF_CONFIG = {
      PAYMENT_DUEDATE_WARNING: { scheduleOffset: 5 },
      PAYMENT_DUEDATE_REACHED: { scheduleOffset: null },
      PAYMENT_OVERDUE:         { scheduleOffset: 5 },
    };

    for (const userDoc of usersSnap.docs) {
      const userData = { uid: userDoc.id, ...userDoc.data() };

      if (!userData.asaasId || userData.ativo === false) {
        results.skipped++;
        continue;
      }

      try {
        // Lista as notificações atuais do cliente no Asaas
        const listResp = await fetch(
          `${ASAAS_BASE_URL}/customers/${userData.asaasId}/notifications`,
          { headers: { access_token: apiKey, 'Content-Type': 'application/json' } }
        );
        const listText = await listResp.text();
        const listData = listText ? JSON.parse(listText) : {};

        if (!listResp.ok) {
          throw new Error(listData.errors?.[0]?.description || `HTTP ${listResp.status}`);
        }

        let notifOk = 0;
        for (const notif of (listData.data || [])) {
          const cfg = NOTIF_CONFIG[notif.event];
          if (!cfg) continue;

          const body = {
            enabled:                    true,
            smsEnabledForCustomer:      true,
            emailEnabledForCustomer:    false,
            whatsappEnabledForCustomer: false,
          };
          // Só envia scheduleOffset para eventos que têm dias configuráveis
          if (cfg.scheduleOffset !== null) body.scheduleOffset = cfg.scheduleOffset;

          const updResp = await fetch(
            `${ASAAS_BASE_URL}/customers/${userData.asaasId}/notifications/${notif.id}`,
            {
              method: 'PUT',
              headers: { access_token: apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          );
          const updText = await updResp.text();
          const updData = updText ? JSON.parse(updText) : {};

          if (!updResp.ok) {
            // Loga o erro de notificação individual mas não para o loop
            console.warn(
              `configureAsaasNotifications: notif ${notif.event} falhou para ${userDoc.id}:`,
              updData.errors?.[0]?.description || `HTTP ${updResp.status}`
            );
          } else {
            notifOk++;
          }

          await new Promise(r => setTimeout(r, 100));
        }

        if (notifOk > 0) {
          results.configured++;
        } else {
          results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: 'Nenhuma notificação configurada' });
        }
      } catch (err) {
        console.error('configureAsaasNotifications error:', userDoc.id, err.message);
        results.errors.push({ uid: userDoc.id, nome: userData.nome || '—', error: err.message });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    console.log('configureAsaasNotifications result:', results);
    return results;
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

    // Só sincroniza se nome, telefone ou CPF mudaram
    const changed = ['nome', 'telefone', 'cpf'].some(f => before[f] !== after[f]);
    if (!changed) return null;

    try {
      const apiKey = await getAsaasApiKey();
      const resp = await fetch(`${ASAAS_BASE_URL}/customers/${after.asaasId}`, {
        method: 'POST',
        headers: { access_token: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:        (after.nome || '').trim(),
          cpfCnpj:     (after.cpf || '').replace(/\D/g, ''),
          mobilePhone: formatPhoneForAsaas(after.telefone),
        }),
      });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : {};
      if (!resp.ok) throw new Error(data.errors?.[0]?.description || `HTTP ${resp.status}`);

      console.log(`onAssociadoAtualizado: uid=${context.params.uid} asaasId=${after.asaasId} sincronizado`);
    } catch (err) {
      console.error('onAssociadoAtualizado error:', context.params.uid, err.message);
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

    // Idempotência: verifica se já existe fatura com esse asaasPaymentId
    const existing = await db.collection('users').doc(uid)
      .collection('financeInvoices')
      .where('asaasPaymentId', '==', payment.id)
      .limit(1).get();

    if (!existing.empty) {
      console.log('asaasWebhook: pagamento já registrado', payment.id);
      return res.status(200).send('OK');
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      console.warn('asaasWebhook: usuário não encontrado', uid);
      return res.status(200).send('OK');
    }

    const planType  = String(userSnap.data().planType || 'mensal').toLowerCase().trim();
    const dueDate   = new Date(verifyData.dueDate);
    const paidAt    = new Date(verifyData.paymentDate || verifyData.confirmedDate || new Date());
    const planStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
    const planEnd   = calculatePlanEnd(planStart, planType);
    const dueDateStr = dueDate.toISOString().slice(0, 10);
    const now        = admin.firestore.FieldValue.serverTimestamp();

    const invoicesRef = db.collection('users').doc(uid).collection('financeInvoices');

    // Procura fatura em_aberto com a mesma dueDate para atualizar ao invés de criar nova
    const existingSnap = await invoicesRef
      .where('dueDate', '==', admin.firestore.Timestamp.fromDate(dueDate))
      .where('status', 'in', ['em_aberto', 'atrasado', 'vencido'])
      .limit(1).get();

    const paymentPayload = {
      status:         'pago',
      paidAt:         admin.firestore.Timestamp.fromDate(paidAt),
      amount:         verifyData.value,
      asaasPaymentId: payment.id,
      invoiceUrl:     verifyData.invoiceUrl || null,
      planType,
      planStart:      admin.firestore.Timestamp.fromDate(planStart),
      planEnd:        admin.firestore.Timestamp.fromDate(planEnd),
      updatedAt:      now,
    };

    if (!existingSnap.empty) {
      // Atualiza a fatura existente — evita duplicata e resolve o status corretamente
      await existingSnap.docs[0].ref.update(paymentPayload);
      console.log(`asaasWebhook: fatura atualizada uid=${uid} invoiceId=${existingSnap.docs[0].id} payment=${payment.id}`);
    } else {
      // Não havia fatura pré-criada — cria uma nova
      await invoicesRef.add({
        ...paymentPayload,
        dueDate:   admin.firestore.Timestamp.fromDate(dueDate),
        createdAt: now,
      });
      console.log(`asaasWebhook: fatura criada uid=${uid} payment=${payment.id} planType=${planType}`);
    }

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

  await admin.auth().updateUser(targetUid, { password: newPassword });
  await admin.firestore().collection('users').doc(targetUid).update({
    primeiroAcesso: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`resetUserPassword: senha redefinida para uid=${targetUid} por master uid=${context.auth.uid}`);
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

// ─── SAAS MULTI-TENANT ────────────────────────────────────────────────────────


