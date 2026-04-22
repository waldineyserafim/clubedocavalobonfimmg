const functions = require('firebase-functions');

const admin = require('firebase-admin');

const nodemailer = require('nodemailer');

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

 

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

            <td>${user.nome}</td>

            <td>${user.apelido || '—'}</td>

            <td>${user.telefone || '—'}</td>

            <td>${user.vencimento}</td>

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

            <td>${user.nome}</td>

            <td>${user.apelido || '—'}</td>

            <td>${user.telefone || '—'}</td>

            <td>${user.vencimento}</td>

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

            <td>${user.nome}</td>

            <td>${user.apelido || '—'}</td>

            <td>${user.telefone || '—'}</td>

            <td>${user.vencimento}</td>

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

            <td>${user.nome}</td>

            <td>${user.apelido || '—'}</td>

            <td>${user.telefone || '—'}</td>

            <td>${user.vencimento}</td>

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