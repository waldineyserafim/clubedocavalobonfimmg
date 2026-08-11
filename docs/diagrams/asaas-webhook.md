# Webhook Asaas (mensalidade)

```mermaid
sequenceDiagram
    participant Asaas
    participant WH as asaasWebhook (Cloud Function)
    participant API as Asaas API
    participant FS as Firestore

    Asaas->>WH: POST {event, payment} + header asaas-access-token
    WH->>WH: valida token (Secret Manager)
    alt evento != PAYMENT_RECEIVED/CONFIRMED
        WH-->>Asaas: 200 OK (ignorado)
    end
    WH->>API: GET /payments/{id} (anti-fraude)
    API-->>WH: status real do pagamento
    WH->>API: GET /subscriptions/{id} → externalReference (uid)
    WH->>FS: upsertInvoiceFromAsaasPayment (idempotente por asaasPaymentId)
    WH->>FS: updateFinanceSummary(uid)
    WH-->>Asaas: 200 OK
```

O webhook de leilão (`auctionAsaasWebhook`) segue exatamente o mesmo padrão, com token próprio (`ASAAS_AUCTION_WEBHOOK_TOKEN`) e resolvendo `saleId` (em vez de `uid`) via `payment.externalReference`. Ver [../ASAAS.md](../ASAAS.md).
