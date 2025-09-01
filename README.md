
# Clube do Cavalo — Template Bootstrap (com login)

Site estático responsivo baseado em **Bootstrap 5** (via CDN). Inclui páginas de **Eventos**, **Galeria**, **Diretoria**, **Parcerias** e **Área do Associado** (UI de login/registro/esqueci a senha).*> Observação: a autenticação é apenas **interface**. Para login real, integre um provedor (ex.: Firebase Auth, Supabase, Auth0).

## Estrutura
```
/ (raiz)
  index.html
  events.html
  gallery.html
  board.html
  partners.html
  pagamentos.html
  /assets
    /css/custom.css
    /js/main.js
    /img/
  /members
    login.html
    register.html
    forgot-password.html
```

## Rodar localmente
Basta abrir `index.html` no navegador.

## Publicar no GitHub Pages
1. Crie um repositório e envie estes arquivos para a branch `main`.
2. Em **Settings → Pages**, selecione **Branch: main** e **/root**.
3. Aguarde a publicação em `https://SEU_USUARIO.github.io/NOME_DO_REPO`.

Referências:
- Bootstrap 5 por CDN (jsDelivr) conforme docs oficiais.  
- GitHub Pages — domínio personalizado e CNAME.

## Domínio próprio (opcional)
1. Em **Settings → Pages**, adicione seu domínio em **Custom domain** (isso criará o arquivo `CNAME`).
2. No provedor DNS, crie:
   - **CNAME** para `www` apontando para `SEU_USUARIO.github.io.` (com ponto final).
   - Para o domínio raiz (apex), use **A** para IPs do GitHub Pages ou **ALIAS/ANAME** (conforme seu DNS).
3. Ative **Enforce HTTPS**.

> DNS pode levar até 24h para propagar.

## Personalização rápida
- Cores principais: ajuste `--bs-primary` em `assets/css/custom.css`.
- Logos e fotos: substitua imagens em `assets/img` e os placeholders nas páginas.
- Conteúdo: edite os arquivos `.html` (textos, cards, links).

## Integração de autenticação (sugestão)
- **Firebase Authentication**: adicione o SDK no `members/login.html`/`register.html` e implemente `signInWithEmailAndPassword`/`createUserWithEmailAndPassword`.
- **Supabase Auth**: carregue o script do supabase e use `signInWithPassword`.

## Pagamentos (sugestão)
- **Pix**: gere um QR Code e substitua o placeholder em `pagamentos.html`.
- **PayPal/Stripe**: cole o botão/script oficial do provedor.

---
*Licença*: Uso livre. Manter créditos de imagens/ícones que você adicionar.
