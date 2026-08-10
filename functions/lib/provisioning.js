// functions/lib/provisioning.js — provisionamento automático de organizações
// (Fase 3.3). Mecanismo genérico: nenhuma credencial de e-mail/Secret Manager
// mora aqui (isso é responsabilidade de quem chama, em index.js — mesma
// separação que sendAccountInviteEmail já segue) — só orquestra Firestore +
// Auth Admin SDK, injetados por quem chama, no mesmo estilo de DI de
// organization.js/authorization.js/platform.js/billing/*.
//
// Idempotência: cada passo faz sua própria checagem de existência antes de
// escrever (mesmo padrão de backfillLeilaoOrgId/migratePlatformAdmins). O
// passo 1 (organização) usa .create() atômico do Firestore — não
// "ler-então-escrever" — porque é o único passo onde dois chamadores
// concorrentes pro mesmo orgId precisam ser resolvidos de forma segura sem
// depender de sorte no timing (ver Contexto do plano da Fase 3.3).

const functions = require('firebase-functions');
const logger = require('firebase-functions/logger');

const PROVISIONING_STEPS = ['organization', 'masterAccount', 'modules', 'billing', 'branding', 'storage', 'cms'];

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {import('firebase-admin').auth.Auth} opts.authAdmin
 * @param {() => any} opts.serverTimestamp — ex.: () => admin.firestore.FieldValue.serverTimestamp()
 */
function createProvisioningService({ db, authAdmin, serverTimestamp } = {}) {
  if (!db) throw new Error('createProvisioningService: db é obrigatório.');
  if (!authAdmin) throw new Error('createProvisioningService: authAdmin é obrigatório.');
  if (!serverTimestamp) throw new Error('createProvisioningService: serverTimestamp é obrigatório.');

  /**
   * Orquestra o provisionamento completo de uma organização. Não envia
   * nenhum e-mail — devolve `masterAccount` com o suficiente pra quem chamou
   * (index.js) decidir se/como convidar, só depois de confirmar que todos os
   * passos terminaram em "ok"/"skipped" (ver Contexto do plano — convite só
   * no fim, nunca no meio do provisionamento).
   *
   * @param {object} params
   * @param {string} params.orgId
   * @param {string} params.nome
   * @param {string} params.planId
   * @param {{email: string, nome: string}} params.master
   * @param {boolean} [params.forceReprocess]
   * @param {string} params.requestedBy — uid do Platform Administrator/Owner chamador
   * @param {string} [params.requestedByEmail]
   * @param {string} [params.runId] — ID pré-gerado pelo cliente (ex.:
   *   `doc(collection(db,'provisioningRuns')).id` no SDK client) pra permitir
   *   assinar o doc via onSnapshot ANTES da callable retornar — o assistente
   *   do Painel Master usa isso pro progresso ao vivo. Se ausente, gera um
   *   ID normal (uso interno/testes, sem ninguém observando ao vivo).
   */
  async function provisionOrganization({ orgId, nome, planId, master, forceReprocess, requestedBy, requestedByEmail, runId }) {
    if (!orgId || !nome || !planId || !master?.email || !master?.nome) {
      throw new functions.https.HttpsError('invalid-argument', 'orgId, nome, planId e master{email,nome} são obrigatórios.');
    }

    // Validação prévia — falha rápido, antes de qualquer escrita.
    const planSnap = await db.collection('systemPlans').doc(planId).get();
    if (!planSnap.exists) {
      throw new functions.https.HttpsError('invalid-argument', `Plano "${planId}" não existe.`);
    }
    const masterEmail = String(master.email).trim().toLowerCase();
    const platformAdminWithEmail = await db.collection('platformAdmins').where('email', '==', masterEmail).limit(1).get();
    if (!platformAdminWithEmail.empty) {
      throw new functions.https.HttpsError('invalid-argument', 'Este e-mail já é uma conta de equipe da plataforma — nunca reaproveitada como Organization Master.');
    }

    // Reivindicação atômica do orgId (resolve corrida de duplo envio).
    const orgRef = db.collection('organizations').doc(orgId);
    let orgAlreadyExisted = false;
    try {
      await orgRef.create({
        nome, slug: orgId, plan: planId, ativo: true, status: 'ativa',
        provisioningStatus: 'running',
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        provisionedBy: requestedBy,
      });
    } catch (e) {
      if (e.code !== 6 && e.code !== 'already-exists') throw e; // 6 = ALREADY_EXISTS (gRPC), Admin SDK expõe como e.code numérico ou string dependendo da versão
      orgAlreadyExisted = true;
      const existing = (await orgRef.get()).data();

      if (existing?.provisioningStatus === 'completed' && !forceReprocess) {
        throw new functions.https.HttpsError('already-exists', 'Organização já provisionada. Use "Reprocessar" na própria página da organização se precisar corrigir algo.');
      }

      // Barreira contra dois chamadores concorrentes pro mesmo orgId: o
      // .create() atômico acima já garante que só UM dos dois grava o doc
      // novo — mas o "perdedor" ainda cairia aqui achando que é um
      // reprocessamento legítimo enquanto o "vencedor" ainda está no meio dos
      // 7 passos, o que causaria os dois rodando em paralelo (ex.: duas
      // tentativas de criar o mesmo Master quase ao mesmo tempo). Trata
      // "running" recente como execução de verdade em andamento — só permite
      // seguir se "running" estiver preso há mais tempo que o timeout da
      // function (execução anterior travou/expirou, self-healing).
      const RUNNING_STALE_MS = 6 * 60 * 1000; // margem sobre os 300s de timeout desta function
      if (existing?.provisioningStatus === 'running') {
        const updatedAtMs = existing.updatedAt?.toMillis ? existing.updatedAt.toMillis() : 0;
        const isStale = (Date.now() - updatedAtMs) > RUNNING_STALE_MS;
        if (!isStale) {
          throw new functions.https.HttpsError('already-exists', 'Provisionamento já em andamento para esta organização — aguarde alguns instantes e tente novamente.');
        }
      }

      await orgRef.update({ provisioningStatus: 'running', updatedAt: serverTimestamp() });
    }

    const runRef = runId ? db.collection('provisioningRuns').doc(runId) : db.collection('provisioningRuns').doc();
    await runRef.set({
      orgId, requestedBy, requestedByEmail: requestedByEmail || null, planId,
      status: 'running', startedAt: serverTimestamp(), finishedAt: null, steps: [],
    });

    const stepResults = [];
    async function step(name, fn) {
      const startedAt = new Date();
      let entry;
      try {
        const result = await fn();
        entry = { name, status: result?.skipped ? 'skipped' : 'ok', startedAt, finishedAt: new Date(), error: null };
        stepResults.push({ ...entry, result });
      } catch (e) {
        entry = { name, status: 'error', startedAt, finishedAt: new Date(), error: e.message || String(e) };
        stepResults.push(entry);
        // Antes desta correção, uma falha aqui só existia em
        // provisioningRuns/{runId}.steps — nenhum sinal em Cloud Logging.
        // step() nunca relança (idempotência/reprocessamento é a estratégia,
        // ver Contexto), então sem isto o alerta de provisionamento nunca teria
        // nada pra observar.
        logger.error(`provisionOrganization: passo "${name}" falhou para orgId=${orgId}: ${entry.error}`);
      }
      await runRef.update({ steps: stepResults.map(({ result: _r, ...rest }) => rest) });
      return entry;
    }

    await step('organization', async () => ({ skipped: orgAlreadyExisted }));

    let masterUid = null;
    let masterNewlyCreated = false;
    await step('masterAccount', async () => {
      const existingMaster = await db.collection('users')
        .where('orgId', '==', orgId)
        .where('role', 'in', ['Master', 'master'])
        .limit(1).get();
      if (!existingMaster.empty) {
        masterUid = existingMaster.docs[0].id;
        return { skipped: true };
      }

      const { randomBytes } = require('crypto');
      try {
        const userRecord = await authAdmin.createUser({ email: masterEmail, password: randomBytes(24).toString('hex'), displayName: master.nome });
        masterUid = userRecord.uid;
        masterNewlyCreated = true;
      } catch (e) {
        if (e.code !== 'auth/email-already-exists') throw e;
        // Reprocessamento depois de uma falha parcial: conta Auth foi criada
        // numa tentativa anterior, mas o doc users/{uid} não chegou a ser
        // escrito. Recupera em vez de travar — "nenhum passo deve exigir
        // intervenção manual".
        const existing = await authAdmin.getUserByEmail(masterEmail);
        masterUid = existing.uid;
        masterNewlyCreated = true;
      }

      await db.collection('users').doc(masterUid).set({
        role: 'Master', orgId, nome: master.nome, email: masterEmail,
        ativo: true, primeiroAcesso: true,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }, { merge: true });
      return { skipped: false };
    });

    await step('modules', async () => {
      const modules = planSnap.data().modules || {};
      await orgRef.update({ modules, updatedAt: serverTimestamp() });
      return { skipped: false };
    });

    await step('billing', async () => {
      // Campo do TOPO do documento — o que getBillingProvider() realmente lê
      // (ver Contexto/seção 4 do plano: config.billingProvider era cosmético).
      await orgRef.update({ billingProvider: 'asaas', updatedAt: serverTimestamp() });
      return { skipped: false };
    });

    await step('branding', async () => {
      // Só os campos que a aba Configurações (Fase 3.1) já lê/exibe — nada
      // novo inventado sem consumidor (ver Contexto do plano).
      await orgRef.set({
        config: { idioma: 'pt-BR', timezone: 'America/Sao_Paulo', moeda: 'BRL' },
      }, { merge: true });
      return { skipped: false };
    });

    await step('storage', async () => {
      // Não-op deliberado — object storage não tem pasta pra pré-criar;
      // tenants/{orgId}/... já é a convenção viva, existe a partir do
      // primeiro upload. Justificado, não ignorado silenciosamente.
      return { skipped: true };
    });

    await step('cms', async () => {
      const aboutSnap = await db.collection('cms_about').doc(orgId).get();
      if (aboutSnap.exists) return { skipped: true };
      await db.collection('cms_about').doc(orgId).set({
        orgId, missao: '', atividades: '', beneficios: '',
        updatedAt: serverTimestamp(),
      });
      return { skipped: false };
    });

    const allOk = stepResults.every((s) => s.status === 'ok' || s.status === 'skipped');
    const finalStatus = allOk ? 'completed' : 'failed';

    await runRef.update({ status: finalStatus, finishedAt: serverTimestamp() });
    await orgRef.update({
      provisioningStatus: finalStatus,
      ...(allOk ? { provisionedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(),
    });

    return {
      orgId, runId: runRef.id, status: finalStatus, steps: stepResults,
      master: { uid: masterUid, email: masterEmail, nome: master.nome, newlyCreated: masterNewlyCreated },
      readyForInvite: allOk && masterNewlyCreated,
    };
  }

  return { provisionOrganization, PROVISIONING_STEPS };
}

module.exports = { createProvisioningService, PROVISIONING_STEPS };
