// firebase.js
// IMPORTS (via CDN do Firebase modular)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// === Configuração do Firebase (seus dados) ===
const firebaseConfig = {
  apiKey: "AIzaSyB1HBodrFRmgGKnYtX2v0X5LiIkowhR9wg",
  authDomain: "clubecavalobonfim.firebaseapp.com",
  projectId: "clubecavalobonfim",
  storageBucket: "clubecavalobonfim.firebasestorage.app",
  messagingSenderId: "115015503370",
  appId: "1:115015503370:web:3864e3e55714d33f8319f3"
};

// 2) INICIALIZA
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// mantém a sessão no navegador (login persiste entre páginas)
await setPersistence(auth, browserLocalPersistence);

// ===== Utils CPF =====
export const onlyDigits = (s) => (s || "").replace(/\D/g, "");
export function cpfToEmail(cpfDigits) {
  const clean = onlyDigits(cpfDigits).slice(0, 11);
  return `${clean}@cpf.local`;
}

// 3) CACHE DE PAPEL EM SESSION STORAGE (entre páginas)
const ROLE_KEY = "userRole";
function cacheRole(role) {
  sessionStorage.setItem(ROLE_KEY, role);
}
function loadCachedRole() {
  return sessionStorage.getItem(ROLE_KEY);
}
function clearCachedRole() {
  sessionStorage.removeItem(ROLE_KEY);
}

// 4) BUSCAR PAPEL NO FIRESTORE PELO UID
async function fetchRoleByUid(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    // role padrão "Associado" se não vier no doc
    // (guarde com A maiúsculo para bater com sua regra de negócio)
    return (data.role || "Associado");
  }
  return "Associado";
}

// 5) LOGIN (email/senha) + resolve papel do Firestore
export async function doLogin(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
  const uid = auth.currentUser?.uid;
  const role = await fetchRoleByUid(uid);
  cacheRole(role);
  return role;
}

// 5.1) LOGIN por CPF (azucar sintático, opcional)
export async function doLoginCPF(cpf, password) {
  const email = cpfToEmail(cpf);
  return doLogin(email, password);
}

// 6) CADASTRO (CPF -> e-mail fake) + perfil no Firestore
//    Regras solicitadas:
//    - Campos: cpf, password, nome, telefone, endereco
//    - role inicial: "Associado"
//    - status inicial: "Anuidade Pendente"
export async function doSignupWithProfile({ cpf, password, nome, telefone, endereco }) {
  const email = cpfToEmail(cpf);

  // cria o usuário no Authentication
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  // cria/atualiza o perfil no Firestore
  await setDoc(doc(db, "users", uid), {
    cpf: onlyDigits(cpf),
    nome: (nome || "").trim(),
    telefone: (telefone || "").trim(),
    endereco: (endereco || "").trim(),
    role: "Associado",
    status: "Anuidade Pendente",
    createdAt: serverTimestamp()
  }, { merge: true });

  // guarda papel em cache para navegação
  cacheRole("Associado");

  return { uid };
}

// 7) GUARDA DE ROTA (protege páginas e/ou exige papel)
export function requireAuth(options = {}) {
  const { requiredRole } = options;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Não logado → volta ao login
      redirect("./login.html");
      return;
    }

    // Tenta pegar do cache; se não tiver, busca Firestore
    let role = loadCachedRole();
    if (!role) {
      role = await fetchRoleByUid(user.uid);
      cacheRole(role);
    }

    // Se a página exigir papel específico, verifica (comparação case sensitive)
    if (requiredRole && role !== requiredRole) {
      // Sem permissão → manda para dashboard "geral"
      redirect("./dashboard.html");
      return;
    }

    // Exponha para uso na página
    window.__userRole = role;            // "Admin" | "Operacional" | "Associado" (exemplos)
    window.__userEmail = user.email || "";
    window.__userUid  = user.uid;
  });
}

// 8) LOGOUT
export function doLogout() {
  return signOut(auth).then(() => {
    clearCachedRole();
    redirect("./login.html");
  });
}

// 9) Helper para redirecionar respeitando base path do GitHub Pages
function redirect(relativePath) {
  // Se seu site estiver em https://usuario.github.io/repositorio/,
  // relativePath como "./login.html" funciona corretamente.
  window.location.href = relativePath;
}
