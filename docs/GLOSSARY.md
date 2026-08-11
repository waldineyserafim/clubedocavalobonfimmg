# Glossário

## Termos de negócio

| Termo | Significado |
|---|---|
| **Associado** | Sócio do clube, cadastrado por CPF, sujeito a anuidade recorrente |
| **Associado Mirim** | Categoria especial de associado sem conta de login própria, cobrado no CPF de um responsável, a 50% do valor do plano |
| **Anuidade** | Cobrança recorrente do associado (mensal/trimestral/semestral) |
| **Vigência** (`activeUntil`) | Data até quando o associado tem acesso pago garantido, mesmo após cancelar a renovação |
| **Autocancelamento** | Associado cancela a própria assinatura sem perder acesso imediatamente — mantém benefícios até `activeUntil` |
| **Desativação administrativa** | Admin bloqueia o acesso de um associado imediatamente (`ativo:false`) — mecanismo distinto do autocancelamento |
| **Primeiro Acesso** | Estado (`primeiroAcesso:true`) que força o associado a trocar a senha provisória antes de usar o sistema |
| **Participante de Leilão** | Papel de usuário que só pode dar lances em leilões, não é necessariamente associado do clube |
| **Lote** | Item colocado em leilão (cavalo, genética ou equipamento) |
| **Arrematação** | Ato de vencer um leilão com o maior lance |
| **Repasse** | Valor líquido (após comissão) devolvido ao vendedor de um lote arrematado |
| **Sistema Master / Painel Master** | Camada de administração da Serafim Technologies sobre todo o SaaS, acima do admin do clube |
| **Organização / Tenant** | Um clube-cliente do SaaS, representado por um documento em `organizations/{orgId}` |
| **Módulo** | Funcionalidade opcional habilitável/desabilitável por organização (ex.: leilões, classificados) |
| **Sócio em dia** | Associado sem pendência financeira — condição exigida por alguns eventos para permitir inscrição |
| **Gestão por exceção** | Filosofia da tela `admin_associados.html`: só destaca quem precisa de ação (pendentes), sem listar tudo por padrão |

## Termos técnicos

| Termo | Significado |
|---|---|
| **CPF→email sintético** | Conversão de CPF em um e-mail fictício (`{cpf}@cpf.local`) para usar o Firebase Auth (que exige e-mail) sem expor e-mail real do associado |
| **Role** | Papel de acesso do usuário: `master`, `admin`, `Admin View`/`adminView`, `operador`, `participanteLeilao`, `associado` |
| **`mapRole`/`mapRoleServer`** | Funções (frontend/backend) que normalizam a string de role bruta do Firestore para um dos 6 valores canônicos |
| **`requireAuth`** | Guarda de rota de `firebase.js` que redireciona usuários não autenticados/sem role adequada |
| **`orgId`** | Identificador do tenant (organização) ao qual um documento pertence |
| **`currentOrgId`** | Constante fixa (`"org_bonfim"`) que define o tenant ativo no frontend hoje |
| **`onSnapshot`** | Listener em tempo real do Firestore — atualiza a UI automaticamente quando os dados mudam no servidor |
| **`httpsCallable`** | Mecanismo do SDK do Firebase para chamar uma Cloud Function a partir do cliente, com autenticação automática |
| **Cloud Function `onCreate`/`onUpdate`** | Função disparada automaticamente quando um documento Firestore é criado/atualizado (trigger) |
| **Firestore Security Rules** | Regras declarativas que controlam quem pode ler/escrever cada documento, avaliadas pelo servidor do Firestore |
| **Idempotência** | Propriedade de uma operação poder ser repetida (ex.: reprocessar um webhook) sem duplicar o efeito — garantida aqui via `asaasPaymentId` |
| **Soft delete** | Marcar um documento como `deleted:true` em vez de removê-lo fisicamente |
| **Anti-sniper** | Mecanismo que estende automaticamente o prazo de um leilão se um lance chegar nos últimos segundos, evitando "roubada" de última hora |
| **Webhook** | Endpoint HTTP público que recebe notificações de eventos de um serviço externo (aqui, o Asaas) |
| **Secret Manager** | Serviço do Google Cloud para armazenar credenciais sensíveis fora do código-fonte |
| **`asaasPaymentId`** | Identificador da cobrança no Asaas, usado como chave de deduplicação/idempotência local |
| **`externalReference`** | Campo do Asaas usado para vincular um recurso (cliente/assinatura/cobrança) ao `uid` (ou `saleId`) correspondente no Firebase |
| **Anti-fraude (webhook)** | Prática de reconsultar a API de origem (Asaas) antes de confiar no payload recebido via webhook |
| **`ds-*` (design system)** | Prefixo de classes CSS customizadas do design system do projeto (`ds-card`, `ds-badge`, `ds-pill`, etc.) |
| **Admin View** | Papel de acesso somente-leitura (por convenção de UI, não imposto pelas regras) às telas administrativas |
| **RecaptchaVerifier** | Componente do Firebase Auth necessário para disparar verificação por SMS (Phone Auth), usado no reset de senha |
| **`viewToken`** | Token de posse usado para controlar acesso ao comprovante de inscrição em evento, sem exigir login |
| **`token` (check-in)** | Token distinto do `viewToken`, embutido no QR Code, usado para confirmar presença no evento |

## Siglas e nomes próprios

| Sigla/Nome | Significado |
|---|---|
| **CCBMG** | Clube do Cavalo de Bonfim MG |
| **Asaas** | Plataforma de pagamentos (gateway) usada para cobrança recorrente e avulsa |
| **Serafim Technologies** | Desenvolvedora/mantenedora do sistema |
| **GitHub Pages** | Serviço de hospedagem estática usado para servir o site |
| **LGPD** | Lei Geral de Proteção de Dados (Brasil) |
| **PIX/Boleto/Cartão** | Formas de pagamento suportadas pelo Asaas (`billingType`) |
| **BRT** | Horário de Brasília (fuso usado pelos cron jobs) |
