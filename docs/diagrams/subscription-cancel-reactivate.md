# Cancelamento e Reativação de Assinatura (self-service)

```mermaid
sequenceDiagram
    participant U as Associado
    participant D as pg_associado.html / pay.html
    participant CF as cancelMySubscription
    participant AS as Asaas API
    participant FS as Firestore

    U->>D: clica "Cancelar assinatura"
    D->>U: Passo 1 — confirmar CPF + telefone
    U->>D: confere dados
    D->>U: Passo 2 — mostra "ativo até {activeUntil}"
    U->>D: confirma (checkbox de ciência)
    D->>CF: cancelMySubscription({cpf, telefone})
    CF->>FS: revalida CPF/telefone no servidor
    CF->>AS: POST /subscriptions/{id} {status:"INACTIVE"}
    CF->>AS: cancela cobranças abertas + desliga notificações
    CF->>FS: assinaturaCanceladaEm, assinaturaCanceladaPeloAssociado:true (ativo NÃO muda)
    CF-->>D: {success:true, activeUntil}
```

Reativação (`reactivateMySubscription`) é o inverso: reativa a assinatura (`ACTIVE`), religa notificações, gera cobrança avulsa imediata, remove os campos de cancelamento. Bloqueada se `ativo===false` (desativação administrativa é um mecanismo separado — ver [../GLOSSARY.md](../GLOSSARY.md)).

Contexto completo em [../FLOWS.md](../FLOWS.md) e [../ASAAS.md](../ASAAS.md).
