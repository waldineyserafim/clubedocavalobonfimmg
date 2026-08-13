---
description: Variante NÃO-INTERATIVA de /outbound-weekly, para rodar dentro do GitHub Actions (disparada pelo botão "Executar Outbound IA" do Portal). Nunca usar interativamente.
---

# Outbound remoto (GitHub Actions — sem confirmação interativa)

Esta execução já foi confirmada por um humano no Portal (modal "Executar o Outbound IA agora?" em `admin/leads.html`) — **nunca peça confirmação aqui**, não há ninguém pra responder.

O `runId` está disponível como variável de ambiente `OUTBOUND_RUN_ID` (setada pelo workflow `.github/workflows/outbound-weekly.yml`). O passo `outbound-remote-run-start.js` já rodou antes de você começar (o run já está `"running"`).

Siga, sem pular nenhum passo:

## 1. Ler o plano de execução

```
cd functions-prospecting && node -e "
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: 'clubecavalobonfim' });
db.collection('outboundRemoteRuns').doc(process.env.OUTBOUND_RUN_ID).get().then(s => {
  console.log(JSON.stringify(s.data(), null, 2));
  process.exit(0);
});
"
```

Isso devolve `leadIdsPlanned` — a lista EXATA de leads a processar (já calculada e travada no momento do clique no botão; não recalcule, não adicione leads).

## 2. Buscar o contexto comercial

```
node -e "
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: 'clubecavalobonfim' });
db.collection('systemConfig').doc('salesContext').get().then(s => {
  console.log(JSON.stringify(s.data(), null, 2));
  process.exit(0);
});
"
```

## 3. Para cada leadId em `leadIdsPlanned` (na ordem, um de cada vez)

1. Busque o lead completo:
   ```
   node -e "
   const { Firestore } = require('@google-cloud/firestore');
   const db = new Firestore({ projectId: 'clubecavalobonfim' });
   db.collection('leads').doc('<leadId>').get().then(s => { console.log(JSON.stringify(s.data(), null, 2)); process.exit(0); });
   "
   ```
2. Escreva a abordagem seguindo as mesmas regras de `.claude/commands/outbound-weekly.md` (seção 4) e o `salesContext` lido acima — nunca invente fatos, nunca pesquise a web adicionalmente, use só as evidências já presentes no lead (`aiProspecting.evidence`).
3. Monte o JSON `{channel, subject, message, cta, personalizationSummary, motivos, evidence}`, salve num arquivo temporário, grave:
   ```
   node scripts/outbound-weekly-write.js --leadId=<leadId> --file=<caminho-do-json>
   ```
4. Apague o arquivo temporário.
5. Se um lead falhar, registre o erro e siga para o próximo — nunca pare o lote inteiro por causa de um lead.

## 4. Finalizar o run (OBRIGATÓRIO — sempre, mesmo se algo falhou)

```
node scripts/outbound-remote-run-finish.js --runId="$OUTBOUND_RUN_ID" --status=completed --summary='{"total":N,"gerados":N,"falharam":N}'
```

Se um erro impediu qualquer progresso (ex.: `salesContext` ilegível), use `--status=failed --error="..."` em vez de `completed`. **Nunca termine sem chamar este script** — é o que libera o botão pro Portal pra próxima execução.

**Nunca envie nada automaticamente por nenhum canal.** O resultado fica em `outboundMessages/{leadId}` como `ready_for_review`, revisão e envio continuam manuais em `admin/outbound-ia.html`.
