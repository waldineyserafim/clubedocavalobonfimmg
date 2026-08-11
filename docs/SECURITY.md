# Auditoria de Segurança

Metodologia: leitura integral de `firebase.js`, `functions/index.js`, `firestore.rules`, `storage.rules` e das ~30 páginas HTML, com foco em autenticação, autorização, validação de entrada, exposição de dados e tratamento de segredos. Achados ordenados por prioridade.

## Tabela consolidada de achados

| # | Problema | Impacto | Risco | Probabilidade | Solução recomendada | Prioridade |
|---|---|---|---|---|---|---|
| 1 | `confirmEventCheckin` (Cloud Function, `functions/index.js:3383`) exige apenas `context.auth` — **não checa role**, apesar do comentário no código dizer que deveria ser restrito a admin/master/operador/adminView | Qualquer usuário autenticado (inclusive um `associado` comum) pode confirmar presença de qualquer inscrito em qualquer evento, sem ser da equipe do evento | Médio (integridade de dados de check-in, não financeiro) | Média (requer apenas estar logado, sem UI dedicada para isso, mas chamável via console/devtools) | Adicionar checagem de `mapRoleServer` restrita a `admin`,`master`,`operador`,`adminView`, igual ao padrão já usado nas demais funções administrativas | **Alta** |
| 2 | Regra `auctionLots.update` (`firestore.rules:290-299`) não restringe o valor de `status` quando o dono edita um lote em `rascunho`/`rejeitado` — teoricamente permite pular a aprovação do admin (`rascunho→publicado` direto) | Um vendedor mal-intencionado poderia publicar um lote sem revisão do admin, abrindo para lances reais em item não vetado | Médio-Alto (o admin existe justamente para moderar lotes) | Baixa (exige uso direto do SDK/console, não há botão de UI que produza esse payload) | Adicionar `request.resource.data.status in ["em_analise","cancelado"]` explicitamente nessa cláusula | **Alta** |
| 3 | `isAdminRole()`/`isMaster()` nas Firestore Rules comparam string **exata** (`roleLower()=="admin"`), sem a mesma tolerância de `mapRole()` do frontend (que ignora acentos e reconhece variações como "Admin View") | Uma role gravada como `"Admin View"` é tratada como quase-admin no frontend (`requireAuth` deixa passar, banner de somente-leitura aparece), mas nas regras do Firestore **não** é reconhecida como admin nem como associado especial — cai no comportamento de usuário comum. Pode gerar tanto bloqueios inesperados de operações legítimas quanto uma falsa sensação de que "Admin View" tem acesso amplo de leitura garantido pelas regras (na verdade tem só o que qualquer usuário comum teria) | Baixo-Médio (comportamento inconsistente, não vazamento direto) | Alta (toda vez que essa role é usada) | Alinhar a normalização das regras com `mapRole()`, ou formalizar `adminView` como caso próprio nas rules | Média |
| 4 | Duas Cloud Functions inexistentes chamadas pela UI: `seedMultiTenantData` e `migrateToMultiTenant` (`admin_master_configuracoes.html`) | Erro em produção ao clicar nos botões correspondentes — não é uma falha de segurança per se, mas indica processo de deploy/QA incompleto | Baixo | Alta (sempre que o botão for clicado) | Implementar as funções ou remover os botões até implementar | Média (funcional, não segurança) |
| 5 | Path de Storage `tenants/{orgId}/cms/{category}/{fileName}` aceita escrita de **qualquer usuário autenticado**, sem checar role (`storage.rules:47-51`) | Um associado comum logado poderia, via chamada direta ao SDK (fora da UI), subir arquivos arbitrários (dentro do limite de imagem/5MB) no bucket de CMS de qualquer organização, não só a própria | Baixo-Médio (poluição de armazenamento/custo, phishing de imagem, não RCE) | Baixa (exige conhecimento técnico e não há um driver de UI para isso) | Restringir a regra de Storage a checar a role do usuário via lookup ao Firestore (Storage Rules v2 suporta `firestore.get`) ou aceitar o risco documentando a decisão | Média |
| 6 | Duas coleções de classificados (`classificados` e `memberClassifieds`) com regras quase idênticas mantidas em paralelo | Risco de manutenção: corrigir uma regra e esquecer a outra gera inconsistência de segurança silenciosa | Baixo | Média (a cada alteração futura nas regras) | Consolidar em uma única coleção quando houver janela de manutenção; documentar enquanto isso | Baixa |
| 7 | `login_master.html` mantém uma **segunda cópia hardcoded** da config do Firebase (`apiKey`, etc.) em vez de importar de `firebase.js` | Não é segredo de fato (a `apiKey` do Firebase Web é pública por design — protegida pelas Rules, não por sigilo), mas duplicar a config é risco de desatualização (ex.: rotação de projeto) | Baixo | Baixa | Fazer `login_master.html` importar `firebase.js` como as demais páginas | Baixa |
| 8 | Webhooks Asaas (`asaasWebhook`, `auctionAsaasWebhook`) autenticam por **token estático** em header customizado (`asaas-access-token`), não por assinatura HMAC por requisição | Se o token vazar (log, proxy, etc.), um atacante pode reenviar payloads no formato esperado dentro da janela de validade do token | Médio | Baixa (mitigado pela reconsulta direta à API Asaas antes de confiar no `status` do payload — anti-fraude já implementado) | Já mitigado na prática pela releitura via `GET /payments/{id}`; rotação periódica do token via Secret Manager é suficiente dado o mecanismo de dupla checagem existente | Baixa (aceitável) |
| 9 | Nenhuma página implementa rate limiting client-side/CAPTCHA no login por CPF (`login.html`) além do que o próprio Firebase Auth aplica (`auth/too-many-requests`) | Força bruta de senha por CPF é limitada pelo Firebase Auth nativamente, mas a enumeração de CPFs cadastrados (diferenciar "CPF existe, senha errada" de "usuário não existe") pode ser possível via mensagens de erro do Auth | Baixo | Baixa | Usar mensagens de erro genéricas (já parcialmente feito — `mapErr` em `signup.html` evita vazar "e-mail em uso"; revisar se `login.html` faz o mesmo para `auth/user-not-found` vs `auth/wrong-password`) | Baixa |
| 10 | `eventRegistrations` tem leitura pública (`allow read: if true`) contendo CPF e telefone do inscrito | Um `list` sem filtro (se alguém descobrir como montar a query, dado que não há `list` bloqueado explicitamente diferente de `get`) poderia expor CPF/telefone de inscritos em massa | Médio (dado pessoal — LGPD) | Baixa (a regra permite tecnicamente, mas nenhuma UI expõe listagem sem filtro por evento; ainda assim, `list` aberto é list aberto) | Restringir `list` a exigir pelo menos filtro por `eventoId` (Firestore Rules não conseguem forçar isso diretamente, mas pode-se ao menos remover `list` do `allow read` amplo e permitir só `get`, forçando a aplicação sempre a saber o id do documento) | Média |

## Autenticação e Autorização

- Toda operação sensível de escrita passa por Cloud Functions com Admin SDK (que ignora as Firestore Rules) — o padrão de checagem (`context.auth` → `users/{uid}.role` → `mapRoleServer` → comparação de array) é replicado de forma consistente em quase toda função administrativa (ver [ARCHITECTURE.md](ARCHITECTURE.md)), com as exceções documentadas no achado #1.
- `resetUserPassword` e `deleteAssociado` são as únicas funções restritas estritamente a `master` (não `admin`) — decisão correta dado o poder dessas operações (trocar senha de qualquer um / apagar conta).
- Nenhuma função permite que o chamador force um `uid` de outro usuário para operações "self-service" (`cancelMySubscription`, `reactivateMySubscription`, `getAsaasPaymentLink` sempre usam `context.auth.uid`, nunca um `uid` do payload) — bom padrão contra escalada horizontal.

## Validação de entrada

- CPF validado com dígito verificador completo tanto client-side (várias páginas) quanto server-side (`validateCPF`, `functions/index.js:3104`).
- `_isInvoiceCreateValid()` nas Firestore Rules é um exemplo positivo de validação de schema na própria regra (impede o cliente se autodeclarar "pago").
- `escHtml()` (`functions/index.js:423`) escapa HTML nos e-mails gerados — mitiga injeção de HTML nos relatórios/avisos por e-mail a partir de dados do Firestore.
- **Risco menor**: `sobre.html` sobrescreve seções via `innerHTML` a partir de `cms_about` sem sanitização HTML explícita além de `esc()`/`nl2br()` simples — como a escrita em `cms_about` é restrita a admin/master (`canOperate()`), o vetor de XSS armazenado exigiria comprometer uma conta admin primeiro (risco aceito, dado o modelo de confiança do CMS).

## XSS / CSRF / Injection

- **XSS**: sem framework de templating com escaping automático (é vanilla JS com `innerHTML` em vários pontos) — mitigado pelo fato de que o conteúdo dinâmico vem quase sempre de coleções com escrita restrita a admin/master (CMS). Pontos de atenção: nomes/descrições livres em `memberProducts`/`memberServices`/`memberClassifieds`/`auctionLots`, escritos por associados comuns e renderizados via `innerHTML` em várias telas — um associado poderia tentar injetar `<script>`/`<img onerror>` em um título de produto ou classificado. Não foi confirmado escaping consistente em todas as renderizações desses campos.
- **CSRF**: não aplicável no sentido clássico — não há cookies de sessão custom nem formulários que dependam de estado de sessão do servidor; Firebase Auth usa tokens JWT enviados pelo SDK, que não são enviados automaticamente por navegação cross-site.
- **Injection (SQL/NoSQL)**: Firestore não é vulnerável a injection de query da forma que SQL é (as queries são construídas via SDK tipado, não concatenação de string).

## Upload / Storage

- Ver [STORAGE.md](STORAGE.md) — hard-limit de 5MB e checagem de `contentType` em toda regra de escrita. Achado #5 acima é o ponto mais relevante.

## Escalada de privilégios

- `noSensitiveFieldChange()` (Firestore Rules) é a principal barreira contra um associado se autopromover a `admin`/`master` ou se marcar `ativo:true` após desativação — bem implementada.
- `role` só é editável por `canOperate()` (admin/master) no update de `users` — coerente.

## Enumeração de usuários / Exposição de dados

- `list` em `users` restrito a `canOperate()` — bom, impede um associado comum de listar toda a base.
- `eventRegistrations` — ver achado #10.
- Mensagens de erro de Auth: `signup.html` usa `mapErr` para não vazar "CPF já cadastrado" de forma direta (mapeia para mensagem genérica) — bom padrão de privacidade.

## Ataques de força bruta / DoS / Rate limiting

- `startPasswordReset` tem rate limit explícito (5/hora/CPF, transação Firestore) — bom padrão, correto.
- Login por CPF depende do rate limit nativo do Firebase Auth (`auth/too-many-requests`) — aceitável.
- **Sem rate limit dedicado** nas Cloud Functions HTTP callable em geral — o Firebase Functions v1 aplica limites de concorrência/cota de projeto por padrão, mas não há proteção específica contra abuso de `createEventRegistration` (pública, sem login) por scripts automatizados além da validação de negócio (CPF, duplicidade). Risco baixo dado o baixo valor de abuso (só cria inscrições, não gera custo financeiro direto).
- `encerrarLotesExpirados` roda a cada 1 minuto mesmo sem lotes para processar — não é um risco de segurança, mas é ineficiência de custo (ver [PERFORMANCE.md](PERFORMANCE.md)).

## Segurança do Firebase / Asaas / Cloud Functions / Webhooks

- Segredos (chave Asaas, tokens de webhook, credenciais de e-mail) **exclusivamente via Secret Manager** — nenhum encontrado hardcoded ou em `.env` versionado (`.gitignore` bloqueia `.env`).
- Webhooks com anti-fraude por reconsulta direta à API (ver achado #8) — mitigação sólida mesmo com token estático.
- Idempotência (`asaasPaymentId`) consistente — protege contra replay de webhook criando faturas duplicadas.
- `deleteAssociado` cancela recursos externos (Asaas) de forma best-effort antes de apagar dados locais — ordem correta (evita órfãos no gateway de pagamento), mas se a exclusão do Firebase Auth falhar após o Firestore já ter sido apagado, fica um usuário Auth órfão sem perfil (edge case tratado parcialmente: erros diferentes de `auth/user-not-found` são relançados como `internal`, alertando o operador).

## Headers HTTP / CORS / Cache

- Não há configuração de headers de segurança customizados observada (GitHub Pages não permite configurar headers HTTP arbitrários facilmente) — sem CSP, sem `X-Frame-Options` explícitos além do que o GitHub Pages aplica por padrão.
- Cache de imagens: `max-age=31536000, immutable` — apropriado dado o naming único por timestamp.
- CORS das Cloud Functions `onRequest` (webhooks): não é necessário CORS para o Asaas (servidor a servidor); as `onCall` usam o protocolo do SDK do Firebase Functions, que já lida com CORS internamente.

## Dependências

- Frontend: sem gerenciador de pacotes para o runtime do site (CDN + vendorizado) — não há `npm audit` possível para o que roda no browser; risco de desatualização silenciosa das libs CDN (Bootstrap Icons, QRCode.js, jsPDF) fixadas por versão exata na URL (`bootstrap-icons@1.11.3`, `qrcode@1.5.3`) — bom (pinned), mas exige atualização manual para receber patches de segurança dessas libs.
- Backend (`functions/package.json`): `firebase-admin ^12.7.0`, `firebase-functions ^4.9.0`, `nodemailer ^8.0.5`, `@google-cloud/secret-manager ^6.1.1` — versões com caret (`^`), permitindo atualizações menores automáticas em `npm install`; recomenda-se `npm audit` periódico (não observável a partir da leitura estática do código).
