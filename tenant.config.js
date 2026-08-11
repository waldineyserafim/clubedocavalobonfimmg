// tenant.config.js — declaração local pro núcleo compartilhado do Portal
// Associativo (shared/). Script clássico (não módulo ES) — precisa carregar
// ANTES de qualquer import do núcleo, de forma síncrona.
//
// Fase 3.10: NÃO declara mais orgId. A organização é resolvida em tempo de
// execução por domains/{location.hostname} (ver shared/core/tenant/
// tenant-context.js e CLAUDE.md, Fase 3.9/3.10) — este mesmo arquivo, byte a
// byte, é servido tanto por clubedocavalobonfim.com.br quanto por
// demo.portalassociativo.com.br (proxy Cloudflare), resolvendo pra
// organizações diferentes. Um orgId fixo aqui seria enganoso — removido de
// propósito, não esquecido.
//
// firebaseConfig replicado de firebase.js (mesma config, deliberadamente
// duplicado nesta fase — trocar firebase.js para ler daqui é migração de
// verdade, fora do escopo da Fase 0). Ver shared/README.md no repositório
// portal-associativo para o contrato completo.

window.__TENANT_CONFIG__ = {
  firebase: {
    apiKey: "AIzaSyB1HBodrFRmgGKnYtX2v0X5LiIkowhR9wg",
    authDomain: "clubecavalobonfim.firebaseapp.com",
    projectId: "clubecavalobonfim",
    storageBucket: "clubecavalobonfim.firebasestorage.app",
    messagingSenderId: "115015503370",
    appId: "1:115015503370:web:3864e3e55714d33f8319f3",
  },
  loginUrl: "./login.html",
};
