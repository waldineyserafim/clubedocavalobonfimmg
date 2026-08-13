// functions/test/outbound-weekly-scripts.test.js — scripts/outbound-weekly-
// list.js e outbound-weekly-write.js (fluxo manual do Outbound via Claude
// Code/Claude Pro, ver CLAUDE.md "Pivô Gemini/Claude Code" e
// .claude/commands/outbound-weekly.md). Roda os scripts como subprocessos de
// verdade (não importa as funções direto) — é exatamente assim que o Claude
// Code local vai chamá-los, então o teste cobre o `parseArgs`/stdout/exit
// code reais, não só a lógica interna.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { seedLead } = require('./helpers/seed');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function runScript(scriptName, args = []) {
  return execFileAsync('node', [path.join(SCRIPTS_DIR, scriptName), ...args], {
    env: process.env, // repassa FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST/GCLOUD_PROJECT do processo de teste
  });
}

module.exports = async function run({ db, t }) {
  /* =======================================================================
     outbound-weekly-list.js
     ======================================================================= */

  await t('outbound-weekly-list: lista leads não arquivados, ordenados por score desc, exclui já abordados', async () => {
    await seedLead(db, { id: 'owl_lead_alto', organizacaoNome: 'Clube Score Alto', aiProspecting: { score: 95, qualificacao: 'quente', evidence: [] } });
    await seedLead(db, { id: 'owl_lead_baixo', organizacaoNome: 'Clube Score Baixo', aiProspecting: { score: 60, qualificacao: 'quente', evidence: [] } });
    await seedLead(db, { id: 'owl_lead_manual', organizacaoNome: 'Clube Cadastro Manual' }); // sem aiProspecting
    await seedLead(db, { id: 'owl_lead_arquivado', organizacaoNome: 'Clube Arquivado', archived: true });
    await seedLead(db, { id: 'owl_lead_ja_enviado', organizacaoNome: 'Clube Já Enviado', aiProspecting: { score: 99, qualificacao: 'quente', evidence: [] } });
    await db.collection('outboundMessages').doc('owl_lead_ja_enviado').set({ status: 'sent' });

    const { stdout } = await runScript('outbound-weekly-list.js', ['--limit=10']);
    const result = JSON.parse(stdout);

    const ids = result.selecionados.map((l) => l.id);
    assert.ok(ids.includes('owl_lead_alto'));
    assert.ok(ids.includes('owl_lead_baixo'));
    assert.ok(ids.includes('owl_lead_manual'));
    assert.ok(!ids.includes('owl_lead_arquivado'), 'lead arquivado nunca deveria aparecer');
    assert.ok(!ids.includes('owl_lead_ja_enviado'), 'lead com abordagem "sent" nunca deveria aparecer de novo');

    const idxAlto = ids.indexOf('owl_lead_alto');
    const idxBaixo = ids.indexOf('owl_lead_baixo');
    assert.ok(idxAlto < idxBaixo, 'score mais alto precisa vir primeiro');

    assert.ok(result.jaAbordados >= 1);

    await db.collection('leads').doc('owl_lead_alto').delete();
    await db.collection('leads').doc('owl_lead_baixo').delete();
    await db.collection('leads').doc('owl_lead_manual').delete();
    await db.collection('leads').doc('owl_lead_arquivado').delete();
    await db.collection('leads').doc('owl_lead_ja_enviado').delete();
    await db.collection('outboundMessages').doc('owl_lead_ja_enviado').delete();
  });

  await t('outbound-weekly-list: lead com abordagem "failed" ou "rejected" volta a ficar elegível (reabordável)', async () => {
    await seedLead(db, { id: 'owl_lead_failed', organizacaoNome: 'Clube Falhou Antes' });
    await db.collection('outboundMessages').doc('owl_lead_failed').set({ status: 'failed' });

    const { stdout } = await runScript('outbound-weekly-list.js', ['--limit=10']);
    const result = JSON.parse(stdout);
    const ids = result.selecionados.map((l) => l.id);
    assert.ok(ids.includes('owl_lead_failed'));

    await db.collection('leads').doc('owl_lead_failed').delete();
    await db.collection('outboundMessages').doc('owl_lead_failed').delete();
  });

  await t('outbound-weekly-list: respeita --limit (teto de segurança, nunca "todos sem ação explícita")', async () => {
    for (let i = 0; i < 5; i++) {
      await seedLead(db, { id: `owl_lead_limit_${i}`, organizacaoNome: `Clube Limit ${i}` });
    }
    const { stdout } = await runScript('outbound-weekly-list.js', ['--limit=3']);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.selecionados.length, 3);

    for (let i = 0; i < 5; i++) {
      await db.collection('leads').doc(`owl_lead_limit_${i}`).delete();
    }
  });

  /* =======================================================================
     outbound-weekly-write.js
     ======================================================================= */

  await t('outbound-weekly-write: grava a abordagem reaproveitando lib/outbound/messages.js (mesmo contrato da Cloud Function)', async () => {
    await seedLead(db, { id: 'oww_lead_1', organizacaoNome: 'Clube Write Teste' });

    const tmpFile = path.join(os.tmpdir(), `oww-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      channel: 'email',
      subject: 'Conversa rápida sobre gestão do clube',
      message: 'Olá! Vimos que o Clube Write Teste está crescendo — talvez o Portal Associativo ajude na gestão.',
      cta: 'Faz sentido conversarmos 15 minutos?',
      personalizationSummary: 'Mencionamos o crescimento recente do clube.',
      motivos: ['Segmento compatível'],
      evidence: [{ url: 'https://exemplo.com', titulo: 'Site oficial', tipoFonte: 'site', informacaoExtraida: 'Clube em expansão' }],
    }));

    const { stdout } = await runScript('outbound-weekly-write.js', ['--leadId=oww_lead_1', `--file=${tmpFile}`]);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.leadId, 'oww_lead_1');
    assert.strictEqual(result.status, 'ready_for_review');

    const doc = await db.collection('outboundMessages').doc('oww_lead_1').get();
    assert.strictEqual(doc.data().status, 'ready_for_review');
    assert.strictEqual(doc.data().message, 'Olá! Vimos que o Clube Write Teste está crescendo — talvez o Portal Associativo ajude na gestão.');
    assert.strictEqual(doc.data().researchPerformed, false, 'fluxo manual não pesquisa web adicional nesta versão');
    assert.strictEqual(doc.data().totalCostUsd, 0, 'geração via Claude Pro/assinatura, nunca API paga — custo sempre 0 aqui');
    assert.strictEqual(doc.data().createdBy, 'claude_code_local');

    fs.unlinkSync(tmpFile);
    await db.collection('leads').doc('oww_lead_1').delete();
    await db.collection('outboundMessages').doc('oww_lead_1').delete();
  });

  await t('outbound-weekly-write: sem --leadId ou --file, falha com mensagem clara (exit code != 0)', async () => {
    await assert.rejects(() => runScript('outbound-weekly-write.js', []));
  });

  await t('outbound-weekly-write: message ausente no JSON falha antes de gravar qualquer coisa', async () => {
    await seedLead(db, { id: 'oww_lead_invalid', organizacaoNome: 'Clube Invalido' });
    const tmpFile = path.join(os.tmpdir(), `oww-invalid-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ subject: 'sem message' }));

    await assert.rejects(() => runScript('outbound-weekly-write.js', ['--leadId=oww_lead_invalid', `--file=${tmpFile}`]));

    const doc = await db.collection('outboundMessages').doc('oww_lead_invalid').get();
    assert.strictEqual(doc.exists, false, 'nada deveria ter sido gravado');

    fs.unlinkSync(tmpFile);
    await db.collection('leads').doc('oww_lead_invalid').delete();
  });
};
