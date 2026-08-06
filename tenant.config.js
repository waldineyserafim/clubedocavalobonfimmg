// tenant.config.js — declaração local do tenant CCBMG para o núcleo
// compartilhado do Portal Associativo (shared/). Script clássico (não
// módulo ES) — precisa carregar ANTES de qualquer import do núcleo, de
// forma síncrona.
//
// firebaseConfig replicado de firebase.js (mesma config, deliberadamente
// duplicado nesta fase — trocar firebase.js para ler daqui é migração de
// verdade, fora do escopo da Fase 0). Ver shared/README.md no repositório
// portal-associativo para o contrato completo.

window.__TENANT_CONFIG__ = {
  orgId: "org_bonfim",
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
