# Deploy

## Fluxo de deploy do Frontend (GitHub Pages)

1. Editar os arquivos `.html`/`.css`/`.js` na raiz do repositório — **não há build step**.
2. `git add`/`commit`/`push` para a branch servida pelo GitHub Pages (branch `main`, conforme configuração do repositório).
3. GitHub Pages publica automaticamente o conteúdo estático no domínio configurado via `CNAME`.
4. `.nojekyll` (raiz) garante que o GitHub Pages não tente processar os arquivos com o Jekyll (evita comportamento inesperado com nomes de arquivo/pastas).

Não há preview/staging automático — qualquer commit na branch de produção vai ao ar imediatamente após o GitHub Pages processar o build (tipicamente menos de 1 minuto).

## Fluxo de deploy do Backend (Firebase)

Comandos executados manualmente pelo desenvolvedor (usando o Firebase CLI, autenticado com a conta que tem acesso ao projeto `clubecavalobonfim`):

```bash
firebase deploy --only functions        # deploy só das Cloud Functions
firebase deploy --only firestore:rules  # deploy só das regras do Firestore
firebase deploy --only firestore:indexes
firebase deploy --only storage          # deploy das regras de Storage
firebase deploy                          # deploy de tudo (functions + rules + indexes)
```

Scripts declarados em `functions/package.json`:
```json
{
  "serve": "firebase emulators:start --only functions",
  "shell": "firebase functions:shell",
  "start": "npm run shell",
  "deploy": "firebase deploy --only functions",
  "logs": "firebase functions:log"
}
```

## Ordem recomendada ao publicar uma mudança que envolve Firestore Rules + Functions juntas

1. Deploy das regras primeiro (`firestore:rules`) se a mudança **amplia** permissões necessárias para uma nova função funcionar.
2. Deploy das funções depois.
3. Se a mudança **restringe** permissões (torna as regras mais estritas), inverter a ordem — funções antigas continuam operando com Admin SDK (ignora regras), então o risco é só para o frontend, que deve ser publicado só depois de confirmado que as novas regras não quebram fluxos existentes.

## Rollback

- **Frontend**: `git revert`/`git reset` do commit problemático + novo push — GitHub Pages republica o estado anterior automaticamente. Sem plano B fora do Git.
- **Cloud Functions**: o Firebase CLI mantém histórico de versões por função no Google Cloud Console; rollback via redeploy do código anterior (`firebase deploy --only functions` a partir de um checkout de commit anterior) — não há comando de "rollback automático" de 1 clique documentado no repositório.
- **Firestore Rules**: o Firebase Console mantém histórico de versões de regras publicadas, com opção de reverter para uma versão anterior diretamente pelo console (fora do fluxo de código).

## Versionamento

Git/GitHub, sem tags de release observadas. O histórico de commits (mensagens descritivas em português) é a única trilha formal de versões — recomenda-se, como melhoria de processo (não obrigatória), começar a taguear releases (`git tag vX.Y.Z`) quando mudanças de maior impacto (ex.: mudanças de schema Firestore, novas Cloud Functions) forem publicadas, para facilitar rollback e auditoria futura.

## Ambientes

Não há ambientes de homologação separados — testar mudanças antes de produção depende de: (a) rodar o site localmente via `npm run serve` (porta 3333) e (b) usar os emuladores do Firebase (`firebase emulators:start`) para Functions/Firestore/Auth, configurados em `firebase.json`. Não há evidência de uso rotineiro de um segundo projeto Firebase de staging.

## Checklist mínimo antes de publicar (baseado nas convenções observadas no código)

1. Rodar a suíte Playwright localmente (`npm run test:e2e`) — cobre regressão de design system, integridade de IDs usados pelo JS, permissões/roles e contratos de Asaas/leilões (via inspeção estática).
2. Conferir que nenhuma nova página quebrou o padrão de `design-system.css`/navbar/footer (testado por `05-design-system-regression.spec.js`).
3. Se a mudança tocar Firestore Rules, revalidar manualmente os fluxos de leitura pública que dependem delas (classificados, leilões, eventos) — não há testes automatizados que rodem contra o emulador de regras.
4. Se a mudança tocar Cloud Functions relacionadas a Asaas, verificar no ambiente do Asaas (sandbox, se configurado externamente — não há evidência de sandbox no código, que aponta sempre para `api.asaas.com` produção) antes de publicar.
