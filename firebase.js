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
  serverTimestamp,
  collection,
  addDoc,
  updateDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAt,
  endAt,
  Timestamp
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

// ===== Utils gerais =====
export const onlyDigits = (s) => (s || "").replace(/\D/g, "");
export function cpfToEmail(cpfDigits) {
  const clean = onlyDigits(cpfDigits).slice(0, 11);
  return `${clean}@cpf.local`;
}
// normaliza acentos/caixa para comparar papéis
const norm = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();

// 3) CACHE DE PAPEL EM SESSION STORAGE (entre páginas)
const ROLE_KEY = "userRole";
function cacheRole(role) { sessionStorage.setItem(ROLE_KEY, role); }
function loadCachedRole() { return sessionStorage.getItem(ROLE_KEY); }
function clearCachedRole() { sessionStorage.removeItem(ROLE_KEY); }

// 4) BUSCAR PAPEL NO FIRESTORE PELO UID
async function fetchRoleByUid(uid) {
  if (!uid) return "associado";
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    return (data.role || "associado");
  }
  return "associado";
}

// 4.1) (Novo) Buscar perfil completo
export async function getUserProfile(uid) {
  if (!uid) return null;
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

// 4.2) (Novo) Derivar status ativo/pendente de forma resiliente
export async function getUserStatus(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return { active: false, pending: false, profile: null };

  const statusStr = String(profile.status ?? profile.situacao ?? profile.sit ?? "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

  const pendingByStatus  = /pend/.test(statusStr);
  const inactiveByStatus = pendingByStatus || /inativ|suspens|bloquead/.test(statusStr);

  let active = !inactiveByStatus;

  if (typeof profile.isActive === "boolean") active = active && profile.isActive;
  if (typeof profile.ativo    === "boolean") active = active && profile.ativo;

  let pending =
    pendingByStatus ||
    !!(profile.pendenciasFinanceiras ?? profile.hasPendingPayments ?? profile.pendingPayments ?? profile.pendencias ?? false);

  if (!pending) {
    try {
      const summaryRef = doc(db, "users", uid, "finance", "summary");
      const summarySnap = await getDoc(summaryRef);
      if (summarySnap.exists()) {
        const s = summarySnap.data();
        if (typeof s?.balance === "number" && s.balance > 0) pending = true;
      }
    } catch (_) {}
  }

  return { active, pending, profile };
}

// 5) LOGIN (email/senha) + resolve papel do Firestore
export async function doLogin(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
  const uid = auth.currentUser?.uid;
  const role = await fetchRoleByUid(uid);
  cacheRole(role);
  return role;
}

// 5.1) LOGIN por CPF (açúcar sintático)
export async function doLoginCPF(cpf, password) {
  const email = cpfToEmail(cpf);
  return doLogin(email, password);
}

/* 6) CADASTRO padrão (via tela pública de signup) */
export async function doSignupWithProfile({ cpf, password, nome, telefone, endereco }) {
  const email = cpfToEmail(cpf);

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  await setDoc(doc(db, "users", uid), {
    cpf: onlyDigits(cpf),
    email,
    nome: (nome || "").trim(),
    telefone: (telefone || "").trim(),
    endereco: (endereco || "").trim(),
    role: "associado",
    status: "Anuidade Pendente",
    ativo: true,
    createdAt: serverTimestamp()
  }, { merge: true });

  cacheRole("associado");
  return { uid };
}

// 7) GUARDA DE ROTA (protege páginas e/ou exige papel)
export function requireAuth(options = {}) {
  const { requiredRole } = options;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      redirect("./login.html");
      return;
    }

    // pega papel (cache → firestore)
    let role = loadCachedRole();
    if (!role) {
      role = await fetchRoleByUid(user.uid);
      cacheRole(role);
    }

    if (requiredRole) {
      const required = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
      const ok = required.map(norm).includes(norm(role));
      if (!ok) {
        redirect("./dashboard.html"); // altere se tiver outra rota
        return;
      }
    }

    window.__userRole = role;
    window.__userEmail = user.email || "";
    window.__userUid  = user.uid;
  });
}


// 8) LOGOUT
export function doLogout() {
  return signOut(auth).then(() => {
    clearCachedRole();
    redirect("./login.html?logout=1"); // garante tela limpa p/ trocar de usuário
  });
}

// 9) Helper para redirecionar
function redirect(relativePath) {
  window.location.href = relativePath;
}

/* =========================================================================
   === FUNÇÕES DE DADOS PARA "OPERAÇÃO" (Serviços, Produtos, Classificados, Financeiro) ===
   ======================================================================== */

// ===== Helpers de tipo/parse =====
const toStr = (v) => (v == null ? "" : String(v));
const strArray = (v) =>
  Array.isArray(v)
    ? v.map(toStr).filter(Boolean)
    : toStr(v).split(",").map(s => s.trim()).filter(Boolean);

const toNumberOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toTimestamp = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Timestamp.fromDate(v);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
};

// ===== Serviços =====
export async function addMemberService({ title, description, benefit, imageUrl, whatsapp, active = true }) {
  const payload = {
    title: toStr(title),
    description: toStr(description),
    benefit: toStr(benefit),
    imageUrl: toStr(imageUrl),
    whatsapp: onlyDigits(whatsapp),
    active: !!active,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "memberServices"), payload);
  return ref.id;
}

export async function updateMemberService(id, partial) {
  const ref = doc(db, "memberServices", id);
  const patch = { updatedAt: serverTimestamp() };
  if ("title" in partial) patch.title = toStr(partial.title);
  if ("description" in partial) patch.description = toStr(partial.description);
  if ("benefit" in partial) patch.benefit = toStr(partial.benefit);
  if ("imageUrl" in partial) patch.imageUrl = toStr(partial.imageUrl);
  if ("whatsapp" in partial) patch.whatsapp = onlyDigits(partial.whatsapp);
  if ("active" in partial) patch.active = !!partial.active;
  await updateDoc(ref, patch);
}

// ===== Produtos =====
export async function addMemberProduct({ title, description, benefit, imageUrls, whatsapp, price = null, active = true }) {
  const payload = {
    title: toStr(title),
    description: toStr(description),
    benefit: toStr(benefit),
    imageUrls: strArray(imageUrls),
    whatsapp: onlyDigits(whatsapp),
    price: toNumberOrNull(price),
    active: !!active,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "memberProducts"), payload);
  return ref.id;
}

export async function updateMemberProduct(id, partial) {
  const ref = doc(db, "memberProducts", id);
  const patch = { updatedAt: serverTimestamp() };
  if ("title" in partial) patch.title = toStr(partial.title);
  if ("description" in partial) patch.description = toStr(partial.description);
  if ("benefit" in partial) patch.benefit = toStr(partial.benefit);
  if ("imageUrls" in partial) patch.imageUrls = strArray(partial.imageUrls);
  if ("whatsapp" in partial) patch.whatsapp = onlyDigits(partial.whatsapp);
  if ("price" in partial) patch.price = toNumberOrNull(partial.price);
  if ("active" in partial) patch.active = !!partial.active;
  await updateDoc(ref, patch);
}

// ===== Classificados =====
export async function addMemberClassified({ title, description, imageUrls, whatsapp, price = null, active = true, approved = false }) {
  const payload = {
    title: toStr(title),
    description: toStr(description),
    imageUrls: strArray(imageUrls),
    whatsapp: onlyDigits(whatsapp),
    price: toNumberOrNull(price),
    active: !!active,
    approved: !!approved,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "memberClassifieds"), payload);
  return ref.id;
}

export async function updateMemberClassified(id, partial) {
  const ref = doc(db, "memberClassifieds", id);
  const patch = { updatedAt: serverTimestamp() };
  if ("title" in partial) patch.title = toStr(partial.title);
  if ("description" in partial) patch.description = toStr(partial.description);
  if ("imageUrls" in partial) patch.imageUrls = strArray(partial.imageUrls);
  if ("whatsapp" in partial) patch.whatsapp = onlyDigits(partial.whatsapp);
  if ("price" in partial) patch.price = toNumberOrNull(partial.price);
  if ("active" in partial) patch.active = !!partial.active;
  if ("approved" in partial) patch.approved = !!partial.approved;
  await updateDoc(ref, patch);
}

// ===== Financeiro =====
export async function setFinanceSummary(uid, { balance, lastPayment, nextDue, lastAmount } = {}) {
  const ref = doc(db, "users", uid, "finance", "summary");
  const payload = { updatedAt: serverTimestamp() };
  const bn = toNumberOrNull(balance);
  if (bn !== null) payload.balance = bn;
  const la = toNumberOrNull(lastAmount);
  if (la !== null) payload.lastAmount = la;
  const lp = toTimestamp(lastPayment);
  if (lp) payload.lastPayment = lp;
  const nd = toTimestamp(nextDue);
  if (nd) payload.nextDue = nd;
  await setDoc(ref, payload, { merge: true });
}

export async function addInvoice(uid, { dueDate, amount, status }) {
  const invRef = collection(db, "users", uid, "finance", "invoices");
  const payload = {
    dueDate: toTimestamp(dueDate) || serverTimestamp(),
    amount: Number(amount || 0),
    status: (toStr(status).toLowerCase() || "em_aberto"),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(invRef, payload);
  return ref.id;
}

export async function updateInvoice(uid, invoiceId, partial) {
  const ref = doc(db, "users", uid, "finance", "invoices", invoiceId);
  const patch = { updatedAt: serverTimestamp() };
  if (partial.dueDate) patch.dueDate = toTimestamp(partial.dueDate);
  if (partial.amount != null && partial.amount !== "") patch.amount = Number(partial.amount);
  if (partial.status) patch.status = toStr(partial.status).toLowerCase();
  await updateDoc(ref, patch);
}

/* ====== Usuários: consultas para a tela de Operação ====== */

export async function findUserUidByCPF(cpf) {
  const clean = onlyDigits(cpf);
  if (!clean) return null;
  const qRef = query(collection(db, "users"), where("cpf", "==", clean));
  const snap = await getDocs(qRef);
  if (snap.empty) return null;
  return snap.docs[0].id;
}

export async function listUsersByName(limitTo = 100) {
  const qRef = query(collection(db, "users"), orderBy("nome"), limit(limitTo));
  const snap = await getDocs(qRef);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function searchUsersByNamePrefix(term, limitTo = 100) {
  const t = (term || "").trim();
  if (!t) return listUsersByName(limitTo);
  const lower = t.toLowerCase();
  const all = await listUsersByName(100);
  return all.filter(u => (u.nome || "").toLowerCase().includes(lower)).slice(0, limitTo);
}

export async function searchUsersByCPF(cpf) {
  const clean = onlyDigits(cpf);
  if (!clean) return [];
  const qRef = query(collection(db, "users"), where("cpf", "==", clean));
  const snap = await getDocs(qRef);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// utilitários exportados
export { Timestamp, serverTimestamp };

// (Novo) Re-export explícito p/ login.html
export {
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  doc,
  getDoc,
  signOut
};

/* ============================
   === Helpers do botão Administração (NOVOS) ===
   ============================ */

// NEW: devolve a role atual (usa cache, senão busca no Firestore)
export async function getCurrentRole() {
  if (auth?.currentUser?.uid) {
    let role = loadCachedRole();
    if (!role) {
      role = await fetchRoleByUid(auth.currentUser.uid);
      cacheRole(role);
    }
    return String(role || "associado").toLowerCase();
  }
  return "associado";
}

// NEW: mostra/oculta o botão Administração (link para operacao.html) somente p/ admin
// Ex.: setupAdminButton('#adminBtn')  ou  setupAdminButton(document.getElementById('adminBtn'))
export function setupAdminButton(target, { href = 'operacao.html', label = 'Administração' } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;

  const hide = () => el.classList.add('d-none');
  const show = () => el.classList.remove('d-none');

  // Se for <li> com <a> dentro (como no seu HTML), ajusta o link e o texto
  const ensureAnchor = () => {
    let a = el.tagName === 'A' ? el : el.querySelector('a');
    if (!a) return;
    a.href = href;
    a.textContent = label;
  };

  hide(); // estado inicial seguro

  onAuthStateChanged(auth, async (user) => {
    hide();
    if (!user) return;
    try {
      const role = await getCurrentRole();
      if (role === 'admin') {
        ensureAnchor();
        show();
      }
    } catch (e) {
      console.warn('setupAdminButton:', e);
      hide();
    }
  });

  // Revalida em navegação pelo histórico (bfcache)
  window.addEventListener('pageshow', () => {
    if (auth.currentUser) {
      getCurrentRole().then(r => {
        if (r === 'admin') { ensureAnchor(); show(); } else { hide(); }
      }).catch(() => hide());
    } else {
      hide();
    }
  });

  // Defesa extra após pequeno atraso
  setTimeout(() => {
    if (auth.currentUser) {
      getCurrentRole().then(r => {
        if (r === 'admin') { ensureAnchor(); show(); } else { hide(); }
      }).catch(() => hide());
    }
  }, 800);
}
