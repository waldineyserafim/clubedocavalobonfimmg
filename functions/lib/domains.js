// functions/lib/domains.js — registro hostname → orgId (Fase 3.5).
//
// Único escritor de domains/{hostname} (Firestore Rules negam qualquer write
// direto do cliente, mesma garantia estrutural de platformAdmins/
// provisioningRuns/organizations — ver Contexto do plano da Fase 3.5). A
// única responsabilidade real deste módulo é garantir unicidade: um hostname
// nunca pode apontar para duas organizações ao mesmo tempo — o resto é
// escrita direta.
//
// Não faz verificação de propriedade de DNS (fora de escopo desta fase — ver
// plano) — "status" fica sempre "verificado" porque, hoje, só existe um
// domínio real (o que já está em produção) sendo cadastrado por quem já o
// administra (Platform Administrator/Owner via Painel Master).

const functions = require('firebase-functions');

/**
 * @param {string} raw
 * @returns {string} hostname normalizado (minúsculas, sem protocolo/path/porta, sem espaços)
 */
function normalizeHostname(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return h;
}

function isValidHostname(h) {
  return !!h && /\./.test(h) && !/\s/.test(h) && !/^\./.test(h) && !/\.$/.test(h);
}

/**
 * @param {object} opts
 * @param {FirebaseFirestore.Firestore} opts.db
 * @param {() => any} opts.serverTimestamp
 */
function createDomainsService({ db, serverTimestamp } = {}) {
  if (!db) throw new Error('createDomainsService: db é obrigatório.');
  if (!serverTimestamp) throw new Error('createDomainsService: serverTimestamp é obrigatório.');

  /**
   * Substitui o conjunto de domínios de uma organização por um novo conjunto
   * (domínio principal + alternativos), validando unicidade contra TODAS as
   * organizações antes de escrever qualquer coisa.
   *
   * @param {object} params
   * @param {string} params.orgId
   * @param {string} params.dominioPrincipal
   * @param {string[]} [params.dominiosAlternativos]
   * @param {string} params.requestedBy — uid de quem chamou (auditoria/criadoPor)
   */
  async function setOrganizationDomains({ orgId, dominioPrincipal, dominiosAlternativos = [], requestedBy }) {
    if (!orgId) {
      throw new functions.https.HttpsError('invalid-argument', 'orgId é obrigatório.');
    }
    const orgSnap = await db.collection('organizations').doc(orgId).get();
    if (!orgSnap.exists) {
      throw new functions.https.HttpsError('not-found', `Organização "${orgId}" não existe.`);
    }

    const principal = normalizeHostname(dominioPrincipal);
    if (!isValidHostname(principal)) {
      throw new functions.https.HttpsError('invalid-argument', 'Domínio principal inválido.');
    }
    const alternativosNormalizados = (dominiosAlternativos || [])
      .map(normalizeHostname)
      .filter((h, i, arr) => h && arr.indexOf(h) === i && h !== principal);
    for (const h of alternativosNormalizados) {
      if (!isValidHostname(h)) {
        throw new functions.https.HttpsError('invalid-argument', `Domínio adicional inválido: "${h}".`);
      }
    }

    const desired = [
      { hostname: principal, tipo: 'primario' },
      ...alternativosNormalizados.map((hostname) => ({ hostname, tipo: 'alternativo' })),
    ];

    // Unicidade: nenhum hostname pode já pertencer a OUTRA organização.
    for (const { hostname } of desired) {
      const snap = await db.collection('domains').doc(hostname).get();
      if (snap.exists && snap.data().orgId !== orgId) {
        throw new functions.https.HttpsError(
          'already-exists',
          `O domínio "${hostname}" já está registrado para outra organização.`
        );
      }
    }

    // Domínios que a organização tinha registrados antes e saíram da lista nova.
    const previousSnap = await db.collection('domains').where('orgId', '==', orgId).get();
    const desiredHostnames = new Set(desired.map((d) => d.hostname));
    const toRemove = previousSnap.docs.filter((d) => !desiredHostnames.has(d.id));

    const batch = db.batch();
    for (const { hostname, tipo } of desired) {
      const ref = db.collection('domains').doc(hostname);
      const existing = previousSnap.docs.find((d) => d.id === hostname);
      batch.set(ref, {
        orgId, tipo, status: 'verificado',
        criadoEm: existing ? existing.data().criadoEm : serverTimestamp(),
        criadoPor: existing ? existing.data().criadoPor : requestedBy,
        atualizadoEm: serverTimestamp(),
      });
    }
    for (const doc of toRemove) {
      batch.delete(doc.ref);
    }
    batch.update(db.collection('organizations').doc(orgId), {
      dominio: principal,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();

    return {
      success: true,
      dominioPrincipal: principal,
      dominiosAlternativos: alternativosNormalizados,
    };
  }

  return { setOrganizationDomains, normalizeHostname, isValidHostname };
}

module.exports = { createDomainsService, normalizeHostname, isValidHostname };
