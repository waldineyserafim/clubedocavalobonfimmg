// firebase.js — camada específica do CCBMG sobre o núcleo compartilhado da
// plataforma (Portal Associativo, shared/). Toda a mecânica genérica (init
// do Firebase, sessão/papel, módulos por organização, auditoria, compressão
// e upload de imagem) vem de lá — aqui fica só o que é deste tenant: CPF↔e-mail,
// vocabulário de papel, status de inadimplência, schema de catálogo
// (produtos/serviços) e o navbar/botão de administração.
//
// Requer que a página carregue <script src="./tenant.config.js"></script>
// ANTES deste módulo (script clássico, síncrono) — é de lá que vem a config
// real do Firebase e o orgId. Ver tenant.config.js e o contrato completo em
// shared/README.md (repositório portal-associativo).

import { initTenantFirebase } from "https://portalassociativo.com.br/shared/core/auth/firebase-init.js?v=2026.08.2";
import { createRoleResolver } from "https://portalassociativo.com.br/shared/core/auth/roles.js?v=2026.08.2";
import { createAuthSession } from "https://portalassociativo.com.br/shared/core/auth/session.js?v=2026.08.2";
import { getTenant } from "https://portalassociativo.com.br/shared/core/tenant/tenant-context.js?v=2026.08.2";
import { createModuleGate } from "https://portalassociativo.com.br/shared/core/tenant/modules.js?v=2026.08.2";
import { createAuditLogger } from "https://portalassociativo.com.br/shared/core/tenant/audit.js?v=2026.08.2";
import { compressImage, createImageUploader } from "https://portalassociativo.com.br/shared/utils/images.js?v=2026.08.2";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  collection,
  addDoc,
  updateDoc,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import {
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js";

// === Config do tenant (window.__TENANT_CONFIG__, ver tenant.config.js) ===
const _tenantConfig = window.__TENANT_CONFIG__;
if (!_tenantConfig || !_tenantConfig.orgId) {
  throw new Error(
    "[firebase.js] window.__TENANT_CONFIG__ ausente ou sem orgId. " +
    'Adicione <script src="./tenant.config.js"></script> ANTES deste módulo (ver tenant.config.js).'
  );
}

// ─── MULTI-TENANT ───────────────────────────────────────────────────────────
export const currentOrgId = _tenantConfig.orgId;
async function getOrgId() {
  return (await getTenant()).orgId;
}

const { auth, db, storage } = initTenantFirebase(_tenantConfig.firebase, { persistence: true });
export { auth, db, storage };

// Compatibilidade: reexports (sem redeclarar nada)
export { ref as sRef, uploadBytes, getDownloadURL };

// ===== Utils gerais (específico do CCBMG: CPF → e-mail interno) =====
export const onlyDigits = (s) => (s || "").replace(/\D/g, "");
export function cpfToEmail(cpfDigits) {
  const clean = onlyDigits(cpfDigits).slice(0, 11);
  return `${clean}@cpf.local`;
}

// ===== Papel: vocabulário do CCBMG sobre o resolver genérico do núcleo =====
// Mesma ordem/prioridade de sempre: master > adminView > admin > operador >
// participanteLeilao > associado (fallback).
const mapRole = createRoleResolver(
  [
    ["master", (n) => n.includes("master")],
    ["adminView", (n) => n.includes("admin") && n.includes("view")],
    ["admin", (n) => n.includes("admin")],
    ["operador", (n) => n.includes("operador")],
    ["participanteLeilao", (n) => n.includes("participante")],
  ],
  "associado"
);

const _session = createAuthSession({
  auth,
  db,
  mapRole,
  roleField: "role",
  roleCollection: "users",
  cacheKey: "userRole",
});

async function fetchRoleByUid(uid) {
  if (!uid) return "associado";
  return _session.fetchRoleByUid(uid);
}

// 4.1) Buscar perfil completo
export async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// 4.2) Derivar status ativo/pendente de forma resiliente (heurística do
// CCBMG sobre campos legados — específico deste tenant, não migra pro núcleo)
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
  try { sessionStorage.setItem("userRole", role); } catch { /* ambiente sem sessionStorage */ }
  return role;
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
    orgId: currentOrgId,
    createdAt: serverTimestamp()
  }, { merge: true });

  try { sessionStorage.setItem("userRole", "associado"); } catch { /* ambiente sem sessionStorage */ }
  return { uid };
}

/* 6b) CADASTRO de Participante de Leilão (usa e-mail real, não CPF→email) */
export async function doSignupParticipanteLeilao({ cpf, email, password, nome, telefone, cidade, estado }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  await setDoc(doc(db, "users", uid), {
    cpf: onlyDigits(cpf),
    email: (email || "").trim().toLowerCase(),
    nome: (nome || "").trim(),
    telefone: (telefone || "").trim(),
    cidade: (cidade || "").trim(),
    estado: (estado || "").trim(),
    role: "participanteLeilao",
    status: "Ativo",
    ativo: true,
    inadimplenteLeilao: false,
    orgId: currentOrgId,
    createdAt: serverTimestamp()
  }, { merge: true });

  try { sessionStorage.setItem("userRole", "participanteLeilao"); } catch { /* ambiente sem sessionStorage */ }
  return { uid };
}

// 7) GUARDA DE ROTA — delega ao núcleo compartilhado, preservando o
// comportamento exato do CCBMG: default de loginUrl, redirecionamento de
// mismatch sempre para "./index.html" (independente de loginUrl), e o
// banner sticky de "Admin View" com o mesmo markup/estilo de sempre.
export function requireAuth(options = {}) {
  const { requiredRole, loginUrl = "./login.html" } = options;

  _session.requireAuth({
    requiredRole,
    loginUrl,
    unauthorizedUrl: "./index.html",
    onRole: (role) => {
      if (role === "adminView") {
        document.body.classList.add("admin-view-mode");
        if (!document.getElementById("__adminViewBanner")) {
          const b = document.createElement("div");
          b.id = "__adminViewBanner";
          b.style.cssText = "background:#fff3cd;color:#664d03;text-align:center;padding:.3rem;font-size:.78rem;font-weight:600;border-bottom:1px solid #ffda6a;position:sticky;top:0;z-index:1030;letter-spacing:.03em;";
          b.textContent = "Acesso somente leitura — Admin View";
          document.body.prepend(b);
        }
      }
    },
  });
}

// 8) LOGOUT
export function doLogout() {
  return _session.doLogout({ redirectUrl: "./login.html?logout=1" });
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
    orgId: currentOrgId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "memberServices"), payload);
  return ref.id;
}
export async function updateMemberService(id, partial) {
  const refDoc = doc(db, "memberServices", id);
  const patch = { updatedAt: serverTimestamp() };
  if ("title" in partial) patch.title = toStr(partial.title);
  if ("description" in partial) patch.description = toStr(partial.description);
  if ("benefit" in partial) patch.benefit = toStr(partial.benefit);
  if ("imageUrl" in partial) patch.imageUrl = toStr(partial.imageUrl);
  if ("whatsapp" in partial) patch.whatsapp = onlyDigits(partial.whatsapp);
  if ("active" in partial) patch.active = !!partial.active;
  await updateDoc(refDoc, patch);
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
    orgId: currentOrgId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "memberProducts"), payload);
  return ref.id;
}
export async function updateMemberProduct(id, partial) {
  const refDoc = doc(db, "memberProducts", id);
  const patch = { updatedAt: serverTimestamp() };
  if ("title" in partial) patch.title = toStr(partial.title);
  if ("description" in partial) patch.description = toStr(partial.description);
  if ("benefit" in partial) patch.benefit = toStr(partial.benefit);
  if ("imageUrls" in partial) patch.imageUrls = strArray(partial.imageUrls);
  if ("whatsapp" in partial) patch.whatsapp = onlyDigits(partial.whatsapp);
  if ("price" in partial) patch.price = toNumberOrNull(partial.price);
  if ("active" in partial) patch.active = !!partial.active;
  await updateDoc(refDoc, patch);
}

// utilitários exportados
export { Timestamp, serverTimestamp };

// Re-exports úteis p/ login.html (compatibilidade)
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
   Multi-Tenant: módulos e logs — delegados ao núcleo compartilhado
   ============================ */

const _moduleGate = createModuleGate({ db, getOrgId, orgCollection: "organizations", cacheTtlMs: 600000 });
export const checkModuleEnabled = _moduleGate.checkModuleEnabled;
export const applyModuleVisibility = _moduleGate.applyModuleVisibility;

const _audit = createAuditLogger({ db, auth, getOrgId, collectionName: "systemLogs" });
export const logAction = _audit.logAction;

/* ============================
   Helpers do botão Administração (navegação — específico do CCBMG)
   ============================ */

export async function getCurrentRole() {
  const role = await _session.getCurrentRole();
  return role || "associado";
}

export function setupAdminButton(target, { href = 'admin.html', label = 'Administração' } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;

  const hide = () => el.classList.add('d-none');
  const show = () => el.classList.remove('d-none');

  const ensureAnchor = () => {
    let a = el.tagName === 'A' ? el : el.querySelector('a');
    if (!a) return;
    a.href = href;
    a.textContent = label;
  };

  hide();

  onAuthStateChanged(auth, async (user) => {
    hide();
    if (!user) return;
    try {
      const role = await getCurrentRole();
      if (role === 'admin' || role === 'master' || role === 'adminView') {
        ensureAnchor();
        show();
      }
    } catch (e) {
      console.warn('setupAdminButton:', e);
      hide();
    }
  });

  window.addEventListener('pageshow', () => {
    if (auth.currentUser) {
      getCurrentRole().then(r => {
        if (r === 'admin' || r === 'master' || r === 'adminView') { ensureAnchor(); show(); } else { hide(); }
      }).catch(() => hide());
    } else {
      hide();
    }
  });

  setTimeout(() => {
    if (auth.currentUser) {
      getCurrentRole().then(r => {
        if (r === 'admin' || r === 'master' || r === 'adminView') { ensureAnchor(); show(); } else { hide(); }
      }).catch(() => hide());
    }
  }, 800);
}

/* ============================
   IMAGENS: compressão + upload — delegados ao núcleo compartilhado
   ============================ */

export { compressImage };
export const uploadImageFile = createImageUploader(storage);

// ── Navbar user (auto) ───────────────────────────────────────────────────────
// Detecta #btnAssociado e atualiza com primeiro nome quando logado.
// Roda automaticamente em todas as páginas que importam firebase.js.
// (Efeito colateral automático específico do CCBMG — deliberadamente NÃO
// migrado pro núcleo compartilhado, que nunca roda nada sozinho ao ser
// importado; ver shared/README.md, "O que NUNCA vai para o núcleo".)
const _initNavbarUser = () => {
  const btn = document.getElementById('btnAssociado');
  if (!btn) return;
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      btn.innerHTML = '<i class="bi bi-person-circle me-1"></i>Entrar';
      btn.href = 'login.html';
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) {
        const firstName = (snap.data().nome || '').trim().split(' ')[0] || 'Associado';
        btn.innerHTML = `<i class="bi bi-person-circle me-1"></i>${firstName}`;
        btn.href = 'pg_associado.html';
      }
    } catch { /* mantém o texto padrão */ }
  });
};
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initNavbarUser);
  } else {
    _initNavbarUser();
  }
}
