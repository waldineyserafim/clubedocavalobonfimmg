---
description: Executa o Outbound semanal manual (Claude Code + Claude Pro) — gera abordagens personalizadas para leads qualificados, sem usar API paga da Anthropic e sem enviar nada automaticamente.
---

# Outbound semanal (Claude Code + Claude Pro)

Você é o próprio motor de geração desta execução — não chame a Anthropic Messages API (nunca use `ANTHROPIC_API_KEY`), a personalização é feita pelo seu próprio raciocínio, autenticado pela assinatura Claude Pro do operador. Ver `CLAUDE.md` seção "Pivô Gemini/Claude Code" para o desenho completo.

Siga estes passos, nesta ordem, sem pular nenhum:

## 1. Listar leads elegíveis

```
cd functions-prospecting && node scripts/outbound-weekly-list.js --limit=20
```

Isso não escreve nada — só lê. Se o comando falhar por falta de credenciais, peça ao usuário para rodar `gcloud auth application-default login` primeiro.

## 2. Mostrar o resumo e pedir confirmação explícita

Apresente exatamente neste formato (adaptando os números reais):

```
Outbound semanal

Leads qualificados disponíveis: <totalQualificados>
Leads já abordados: <jaAbordados>
Leads elegíveis: <elegiveis>

Serão processados: <selecionados.length>

Deseja continuar? [S/N]
```

**Pare aqui e espere a resposta do usuário.** Nunca prossiga sem confirmação explícita.

## 3. Buscar o contexto comercial (sales context)

Leia `organizations/{orgId}` não se aplica aqui — o contexto é `systemConfig/salesContext` (coleção de plataforma). Se não tiver acesso de leitura fácil por script, pergunte ao usuário os pontos-chave (proposta de valor, tom, CTA) ou use os defaults documentados em `lib/outbound/salesContext.js`.

## 4. Para cada lead selecionado (na ordem, um de cada vez)

1. Releia as evidências (`aiProspecting.evidence`) e dados do lead retornados pelo script — **nunca pesquise a web adicionalmente nesta versão** (CLAUDE.md "Pesquisa adicional no Outbound": desabilitada de propósito).
2. Escreva a abordagem seguindo as mesmas regras do prompt do Agente de Outbound (`lib/prospecting/claudeProvider.js`, `buildOutboundSystemPrompt`, seção "Regras inegociáveis"):
   - Nunca afirme algo sobre o lead sem evidência already fornecida.
   - Nunca invente problemas, clientes, eventos, cargos, faturamento, tecnologias.
   - Curta, objetiva, sem "somos líderes"/"solução revolucionária"/emojis em excesso.
   - CTA simples.
   - Assunto só se `channel === "email"`.
3. Monte um JSON com: `{channel, subject, message, cta, personalizationSummary, motivos: [...], evidence: [...]}` — `evidence` deve referenciar só fatos já presentes no lead (copie/adapte as entradas de `aiProspecting.evidence`, nunca invente uma URL nova).
4. Salve esse JSON num arquivo temporário e grave:
   ```
   node scripts/outbound-weekly-write.js --leadId=<id> --file=<caminho-do-json>
   ```
5. Apague o arquivo temporário depois.

Se um lead falhar (erro no script, dado insuficiente), registre e siga para o próximo — nunca deixe um lead travar o lote inteiro.

## 5. Resumo final

Ao terminar todos, mostre:

```
Outbound semanal concluído

Processados: <N>
Gerados com sucesso: <N>
Falharam: <N> (liste quais e por quê)

Abra o Outbound IA no Painel Master para revisar, aprovar/editar e marcar como enviado manualmente.
```

**Nunca envie nada automaticamente por nenhum canal.** O envio é sempre manual, feito pelo comercial depois da revisão em `admin/outbound-ia.html`.
