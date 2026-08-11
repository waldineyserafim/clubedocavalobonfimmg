# Fluxos de Negócio (com diagramas Mermaid)

## Novo associado (cadastro → primeira cobrança)

```mermaid
sequenceDiagram
    participant U as Visitante
    participant S as signup.html
    participant FB as Firebase Auth
    participant FS as Firestore
    participant CF as onNewAssociadoCriado (trigger)
    participant AS as Asaas API

    U->>S: preenche CPF, senha, nome, telefone, endereço
    S->>S: valida CPF (dígito verificador)
    S->>FB: createUserWithEmailAndPassword("{cpf}@cpf.local", senha)
    FB-->>S: uid
    S->>FS: setDoc users/{uid} {role:"associado", status:"Anuidade Pendente", ativo:true}
    FS-->>CF: dispara onCreate
    CF->>AS: findOrCreateAsaasCustomer (POST/GET /customers)
    CF->>AS: syncCustomerNotifications (PUT /notifications/batch)
    CF->>AS: POST /subscriptions (ciclo conforme planType, valor conforme categoria)
    CF->>FS: grava asaasId, asaasSubscriptionId
    S->>U: redirect pay.html
```

Também é possível o **cadastro pelo admin** (`admin_associados.html`), com os dois subfluxos Normal/Mirim descritos em [ADMIN.md](ADMIN.md) — a criação da assinatura Asaas segue o mesmo trigger `onNewAssociadoCriado`, independente de quem criou o documento `users`.

## Login

Ver diagrama completo em [AUTHENTICATION.md](AUTHENTICATION.md)#fluxo-de-login. Resumo do roteamento pós-login: `!active` → `pay.html?reason=inactive`; `pending` → `pay.html?reason=pending`; caso contrário → `pg_associado.html`.

## Pagamento (associado paga fatura pendente)

```mermaid
sequenceDiagram
    participant U as Associado
    participant P as pay.html
    participant CF as getAsaasPaymentLink
    participant AS as Asaas (checkout hospedado)
    participant WH as asaasWebhook
    participant FS as Firestore

    U->>P: acessa pay.html
    P->>CF: httpsCallable getAsaasPaymentLink()
    CF->>AS: GET /payments?subscription=...&status=PENDING|OVERDUE
    AS-->>CF: cobrança mais próxima (ou nenhuma)
    CF-->>P: {invoiceUrl, value, dueDate} ou {emDia:true}
    P->>U: mostra valor/vencimento + botão "Pagar via Asaas"
    U->>AS: abre invoiceUrl em nova aba, paga (PIX/boleto/cartão)
    AS->>WH: POST webhook PAYMENT_RECEIVED/CONFIRMED
    WH->>AS: GET /payments/{id} (anti-fraude)
    WH->>FS: upsertInvoiceFromAsaasPayment (idempotente)
    WH->>FS: updateFinanceSummary(uid)
    P->>FS: onSnapshot finance/summary (watchPayment)
    FS-->>P: lastPayment avançou
    P->>U: redirect pay-success.html
```

## Renovação (associado próximo do vencimento)

```mermaid
flowchart TD
    A["pg_associado.html carrega"] --> B{"onSnapshot finance/summary"}
    B --> C{"activeUntil/nextDue - hoje"}
    C -->|">5 dias"| D["Sem alerta — badge Em dia"]
    C -->|"0 a 5 dias"| E["Badge Em dia + botão Renovar plano visível"]
    C -->|"vencido, atraso <=5 dias (GRACE_OVERDUE_DAYS)"| F["Badge Atrasada/Vencida + alertFinance + botão Renovar + modal overdueModal informativo"]
    C -->|"vencido, atraso >5 dias"| G["Redirect imediato pay.html?reason=overdue_block"]
    E --> H["Clique em Renovar → pay.html"]
    F --> H
```

A renovação em si não tem um fluxo de "escolher plano" — o associado é levado a `pay.html`, que busca a cobrança pendente/atrasada já existente no Asaas (gerada automaticamente pelo ciclo da assinatura) e oferece o checkout hospedado.

## Cancelamento de assinatura (self-service)

```mermaid
sequenceDiagram
    participant U as Associado
    participant D as pg_associado.html / pay.html
    participant CF as cancelMySubscription
    participant AS as Asaas API
    participant FS as Firestore

    U->>D: clica "Cancelar assinatura"
    D->>U: Passo 1 — confirmar CPF + telefone (client-side)
    U->>D: confere dados
    D->>U: Passo 2 — mostra "ativo até {activeUntil}" + checkbox de ciência
    U->>D: confirma
    D->>CF: httpsCallable cancelMySubscription({cpf, telefone})
    CF->>FS: revalida CPF/telefone no servidor
    CF->>CF: bloqueia se ativo===false ou já cancelado
    CF->>AS: POST /subscriptions/{id} {status:"INACTIVE"}
    CF->>AS: cancelOpenPayments (DELETE cobranças PENDING/OVERDUE)
    CF->>AS: setCustomerNotificationsEnabled(false)
    CF->>FS: grava assinaturaCanceladaEm, assinaturaCanceladaPeloAssociado:true (NÃO toca em "ativo")
    CF->>FS: updateFinanceSummary(uid)
    CF-->>D: {success:true, activeUntil}
    D->>U: "Continuará com acesso até {activeUntil}"
```

**Reativação** é o inverso: `reactivateMySubscription` reativa a assinatura (`ACTIVE`), religa notificações, gera uma cobrança avulsa imediata (`createImmediateChargeOnReactivation`) e apaga os campos de cancelamento.

## Inadimplência (bloqueio administrativo vs. autocancelamento)

```mermaid
flowchart LR
    subgraph Admin["Desativação administrativa"]
        A1["admin marca ativo:false em admin_associados.html"] --> A2["onAssociadoAtualizado detecta ativo true→false"]
        A2 --> A3["Asaas: pausa assinatura + cancela cobranças abertas + desliga notificações"]
        A2 --> A4["login.html / getUserStatus bloqueiam login IMEDIATAMENTE"]
    end
    subgraph Self["Autocancelamento pelo associado"]
        B1["cancelMySubscription"] --> B2["Asaas: pausa assinatura + cancela cobranças abertas"]
        B2 --> B3["grava assinaturaCanceladaPeloAssociado:true (ativo permanece true)"]
        B3 --> B4["acesso continua normal até activeUntil vencer"]
        B4 --> B5["gate de inadimplência natural (>5 dias vencido) bloqueia depois, via pg_associado.html"]
    end
```

## Fluxo administrativo (visão geral de uma ação típica no painel)

```mermaid
sequenceDiagram
    participant Op as Admin/Master
    participant UI as admin_*.html
    participant Auth as requireAuth
    participant FS as Firestore
    participant CF as Cloud Function (quando aplicável)
    participant Log as systemLogs

    Op->>UI: acessa a tela
    UI->>Auth: requireAuth({requiredRole:[admin,master,adminView,...]})
    Auth-->>UI: libera acesso (ou redireciona)
    Op->>UI: executa ação (criar/editar/aprovar/excluir)
    alt ação simples (CMS, catálogo)
        UI->>FS: addDoc/updateDoc direto
        UI->>Log: logAction(acao, detalhes)
    else ação sensível (financeiro, exclusão, senha)
        UI->>CF: httpsCallable(...)
        CF->>CF: valida role no servidor (admin/master, ou master-only)
        CF->>FS: executa mudança + auditoria (asaasSync, etc.)
    end
```

## Publicação de Classificados

```mermaid
flowchart TD
    A["Associado logado abre modal Novo Classificado (classificados.html)"] --> B["Preenche título/descrição/valor/whatsapp"]
    B --> C["addDoc memberClassifieds: active:false, approved:false, paymentStatus:pending"]
    C --> D["Upload de até 3 fotos via uploadImageFile (compressão ~200KB)"]
    D --> E["updateDoc com imageUrls"]
    E --> F["Anúncio aguarda moderação — invisível na listagem pública (approved==false)"]
    F --> G["Admin abre admin_classificados.html"]
    G --> H{"Aprovar ou Reprovar?"}
    H -->|Aprovar| I["updateDoc: approved:true, active:true, paymentStatus:pago"]
    H -->|Reprovar| J["updateDoc: approved:false, reviewed:true"]
    I --> K["Anúncio aparece em classificados.html (onSnapshot)"]
```

## Upload de imagens (genérico)

Ver diagrama detalhado em [STORAGE.md](STORAGE.md)#fluxo-de-upload. Todos os módulos seguem: selecionar → comprimir (canvas→JPEG, alvo/dimensão variam por módulo) → validar 5MB → `uploadBytesResumable` (path único por timestamp, cache 1 ano) → `getDownloadURL()` → salvar URL no Firestore.

## Webhook (mensalidade e leilão)

Ver [ASAAS.md](ASAAS.md)#webhooks para os dois diagramas completos (`asaasWebhook` e `auctionAsaasWebhook`).

## Sincronização com Asaas

Ver [ASAAS.md](ASAAS.md)#sincronização-reconciliação — 3 camadas (webhook em tempo real, sync manual sob demanda, reconciliação diária automática às 04:00 BRT), todas convergindo em `upsertInvoiceFromAsaasPayment`.

## Máquina de estados — Lote de Leilão

```mermaid
stateDiagram-v2
    [*] --> rascunho: associado salva rascunho (lote_form.html)
    [*] --> em_analise: associado envia direto para aprovação
    rascunho --> em_analise: "Enviar para aprovação" (meus_lotes.html / lote_form.html)
    rascunho --> cancelado: associado cancela (meus_lotes.html)
    em_analise --> publicado: admin aprova (define startTime/endTime)
    em_analise --> rejeitado: admin rejeita (motivo obrigatório)
    rejeitado --> em_analise: associado reedita e reenvia
    publicado --> encerrado: encerrarLotesExpirados (cron 1 min, endTime vencido)
    publicado --> cancelado: admin cancela (motivo via prompt)
    encerrado --> [*]: sem lance vencedor
    encerrado --> AuctionSale: com lance vencedor (cria auctionSales)
```

```mermaid
stateDiagram-v2
    [*] --> aguardando_pagamento: encerrarLotesExpirados cria auctionSales
    aguardando_pagamento --> pago: auctionAsaasWebhook confirma pagamento
    aguardando_pagamento --> cancelado: verificarInadimplentesDiarios (comprador não pagou a tempo)
    pago --> repasse_liberado: admin libera repasse (liberarRepasse)
```

**Nota**: o valor `concluido`, presente em filtros de UI de várias telas como se fosse um estado possível (do lote ou da venda), **nunca é gravado** por nenhum código lido no repositório — é um estado terminal previsto na interface mas não alcançado por nenhum fluxo automatizado hoje (ver [TECH_DEBT.md](TECH_DEBT.md)).

## Redefinição de senha (self-service via SMS)

```mermaid
sequenceDiagram
    participant U as Associado
    participant R as reset_senha.html
    participant CF1 as startPasswordReset
    participant Phone as Firebase Phone Auth
    participant CF2 as completePasswordReset
    participant FS as Firestore

    U->>R: informa CPF
    R->>CF1: httpsCallable({cpf})
    CF1->>FS: rate-limit (5/hora) via passwordResetAttempts/{cpf}
    CF1->>FS: busca users where cpf==X, lê telefone
    CF1-->>R: {telefoneE164}
    R->>Phone: signInWithPhoneNumber(telefoneE164, RecaptchaVerifier invisível)
    Phone-->>U: envia SMS com código
    U->>R: digita código + nova senha
    R->>Phone: confirmationResult.confirm(code)
    Phone-->>R: sessão Auth temporária com claim phone_number verificado
    R->>CF2: httpsCallable({cpf, newPassword}) [autenticado com a sessão de telefone]
    CF2->>CF2: compara context.auth.token.phone_number com o telefone do perfil
    CF2->>FS: busca targetUid via cpf
    CF2->>FS: admin.auth().updateUser(targetUid, {password})
    CF2->>FS: primeiroAcesso:false
    CF2->>FS: apaga usuário Auth temporário da sessão de telefone
    R->>Phone: signOut (encerra sessão temporária)
    R->>U: redireciona para login.html
```

## Fluxo de check-in de evento (ponta a ponta)

```mermaid
flowchart LR
    A["Visitante se inscreve (event_inscricao.html)"] --> B["createEventRegistration valida CPF/prazo/vagas/sócio-em-dia"]
    B --> C["eventRegistrations criado com token + viewToken"]
    C --> D["event_comprovante.html?regId=&vt= gera QR Code apontando para event_checkin.html?token="]
    D --> E["No dia do evento: staff escaneia o QR"]
    E --> F["event_checkin.html (requireAuth staff) chama confirmEventCheckin({token})"]
    F --> G["status: confirmado, confirmedAt, confirmedBy"]
```
