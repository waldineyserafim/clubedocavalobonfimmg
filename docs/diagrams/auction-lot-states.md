# Máquina de Estados — Leilão

## Lote (`auctionLots.status`)

```mermaid
stateDiagram-v2
    [*] --> rascunho: associado salva rascunho
    [*] --> em_analise: associado envia direto para aprovação
    rascunho --> em_analise: Enviar para aprovação
    rascunho --> cancelado: associado cancela
    em_analise --> publicado: admin aprova
    em_analise --> rejeitado: admin rejeita
    rejeitado --> em_analise: associado reedita e reenvia
    publicado --> encerrado: cron encerrarLotesExpirados (endTime vencido)
    publicado --> cancelado: admin cancela
    encerrado --> [*]
```

## Venda (`auctionSales.status`)

```mermaid
stateDiagram-v2
    [*] --> aguardando_pagamento: encerrarLotesExpirados cria a venda
    aguardando_pagamento --> pago: auctionAsaasWebhook confirma
    aguardando_pagamento --> cancelado: verificarInadimplentesDiarios
    pago --> repasse_liberado: admin libera repasse
```

Nota: `concluido` aparece em filtros de UI mas nunca é gravado por nenhum código do sistema — ver [../TECH_DEBT.md](../TECH_DEBT.md) item 17.

Contexto completo em [../FLOWS.md](../FLOWS.md).
