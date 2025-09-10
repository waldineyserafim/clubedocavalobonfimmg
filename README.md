<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <!-- Anti-cache para evitar versão antiga ao voltar -->
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">

  <title>Clube do Cavalo - Bonfim MG</title>
  <meta name="description" content="Clube do Cavalo – eventos, associados, diretoria e parcerias.">

  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <!-- versionamento para bustar cache -->
  <link rel="stylesheet" href="assets/css/custom.css?v=ccbmg-2025-09-10b">

  <style>
    :root{ --brand:#264653; }
    .bg-primary { background-color: var(--brand) !important; }
    .btn-primary { background-color: var(--brand) !important; border-color: var(--brand) !important; }
    .btn-outline-primary { color: var(--brand) !important; border-color: var(--brand) !important; }
    .text-primary { color: var(--brand) !important; }

    /* (1) Logo pequeno na navbar */
    .brand-logo{
      height: 36px; width: auto; margin-right:.5rem; object-fit: contain;
      filter: brightness(0) invert(1);
    }
    @media (min-width: 992px){ .brand-logo{ height: 42px; } }
    .navbar-brand span{ white-space: normal; }

    /* (2) Header com logo grande: topo no desktop, some no mobile */
    .header-logo-lg{ max-width: 160px; height:auto; }
    @media (max-width: 575.98px){ .header-logo-lg{ max-width:110px; } }

    /* (3) Carrossel ALTURA FLUIDA (sem buracos no mobile) */
    .hero-carousel{ height: clamp(260px, 55vh, 520px); overflow:hidden; }
    .hero-carousel .carousel-item{ height: 100%; }
    .hero-carousel .carousel-item img{
      width:100%; height:100%; object-fit:cover; display:block;
    }
    #bannerCarousel{ margin-bottom:0 !important; }

    /* CTAs sobre o carrossel */
    .hero-cta{
      position:absolute; left:50%; bottom:clamp(1rem, 2.5vh, 2.5rem);
      transform:translateX(-50%); z-index:5; display:flex; gap:.75rem; flex-wrap:wrap;
      justify-content:center; width:min(92%, 780px); padding:0 .5rem;
    }
    .hero-cta .btn{ box-shadow:0 .5rem 1rem rgba(0,0,0,.25); }
    @media (max-width: 575.98px){ .hero-cta .btn{ width:100%; } }

    /* Parceiros */
    .partner-logo { width: clamp(110px, 32vw, 190px); height: clamp(70px, 22vw, 120px); object-fit: contain; }

    /* Cards no mobile sem altura forçada */
    @media (max-width: 575.98px){ .card.h-100{ height:auto !important; } }
  </style>
</head>
<body>

<!-- NAVBAR / HEADER -->
<nav class="navbar navbar-expand-lg navbar-dark bg-primary shadow-sm">
  <div class="container">
    <a class="navbar-brand d-flex align-items-center fw-bold" href="index.html">
      <img class="brand-logo" src="assets/img/logo_CCBMG.png?v=ccbmg-2025-09-10b" alt="Logo Clube do Cavalo">
      <span>Clube do Cavalo - Bonfim MG</span>
    </a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#nav" aria-controls="nav" aria-expanded="false" aria-label="Alternar navegação">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="nav">
      <ul class="navbar-nav ms-auto mb-2 mb-lg-0 align-items-lg-center">
        <li class="nav-item"><a class="nav-link" href="events.html">Eventos</a></li>
        <li class="nav-item"><a class="nav-link" href="gallery.html">Fotos</a></li>
        <li class="nav-item"><a class="nav-link" href="board.html">Diretoria</a></li>
        <li class="nav-item"><a class="nav-link" href="partners.html">Parcerias</a></li>
        <li class="nav-item mt-2 mt-lg-0">
          <a class="btn btn-light text-primary ms-lg-3 w-100 w-lg-auto" href="login.html?logout=1">Área do Associado</a>
        </li>
      </ul>
    </div>
  </div>
</nav>

<!-- HERO / BEM-VINDO -->
<header class="bg-light py-3 py-lg-2 border-bottom">
  <div class="container">
    <!-- central no mobile / topo no desktop -->
    <div class="row g-4 align-items-center align-items-lg-start">
      <div class="col-12 col-md-9 col-lg-10">
        <h1 class="display-5 fw-bold mb-2 mb-md-3">Bem-vindo ao Clube do Cavalo de Bonfim MG</h1>
        <p class="lead mb-0">Eventos esportivos, cavalgadas, cursos e uma comunidade apaixonada por cavalos.</p>
      </div>
      <div class="col-12 col-md-3 col-lg-2 d-flex justify-content-md-end">
        <!-- esconde no mobile para ganhar área útil -->
        <img class="img-fluid header-logo-lg d-none d-md-block"
             src="assets/img/logo_CCBMG.png?v=ccbmg-2025-09-10b" alt="Logo CCBMG" loading="lazy">
      </div>
    </div>
  </div>
</header>

<!-- (2) CARROSSEL DE BANNERS COM BOTÕES SOBREPOSTOS -->
<section class="position-relative mb-0">
  <div id="bannerCarousel" class="carousel slide hero-carousel" data-bs-ride="carousel" data-bs-interval="6000">
    <div class="carousel-indicators">
      <button type="button" data-bs-target="#bannerCarousel" data-bs-slide-to="0" class="active" aria-current="true" aria-label="Slide 1"></button>
      <button type="button" data-bs-target="#bannerCarousel" data-bs-slide-to="1" aria-label="Slide 2"></button>
      <button type="button" data-bs-target="#bannerCarousel" data-bs-slide-to="2" aria-label="Slide 3"></button>
    </div>
    <div class="carousel-inner">
      <div class="carousel-item active">
        <img src="assets/banners/banner1.png?v=ccbmg-2025-09-10b" class="d-block w-100" alt="Banner 1" loading="lazy">
      </div>
      <div class="carousel-item">
        <img src="assets/banners/banner2.png?v=ccbmg-2025-09-10b" class="d-block w-100" alt="Banner 2" loading="lazy">
      </div>
      <div class="carousel-item">
        <img src="assets/banners/banner3.png?v=ccbmg-2025-09-10b" class="d-block w-100" alt="Banner 3" loading="lazy">
      </div>
    </div>
    <button class="carousel-control-prev" type="button" data-bs-target="#bannerCarousel" data-bs-slide="prev" aria-label="Anterior">
      <span class="carousel-control-prev-icon" aria-hidden="true"></span>
    </button>
    <button class="carousel-control-next" type="button" data-bs-target="#bannerCarousel" data-bs-slide="next" aria-label="Próximo">
      <span class="carousel-control-next-icon" aria-hidden="true"></span>
    </button>
  </div>

  <!-- CTAs sobre o carrossel -->
  <div class="hero-cta">
    <a href="events.html" class="btn btn-primary btn-lg">Próximos eventos</a>
    <a href="signup.html" class="btn btn-outline-primary btn-lg bg-white">Associe-se</a>
  </div>
</section>

<!-- (3) 3 BOXES -->
<section class="container py-5">
  <div class="row g-4">
    <div class="col-md-4">
      <div class="card h-100 shadow-sm">
        <div class="card-body">
          <h5 class="card-title">Calendário de Eventos</h5>
          <p class="card-text">Competições, leilões, clínicas e cavalgadas regionais.</p>
          <a href="events.html" class="btn btn-outline-primary w-100 w-md-auto">Ver agenda</a>
        </div>
      </div>
    </div>
    <div class="col-md-4">
      <div class="card h-100 shadow-sm">
        <div class="card-body">
          <h5 class="card-title">Galeria de Fotos</h5>
          <p class="card-text">Registros dos melhores momentos do nosso clube.</p>
          <a href="gallery.html" class="btn btn-outline-primary w-100 w-md-auto">Abrir galeria</a>
        </div>
      </div>
    </div>
    <div class="col-md-4">
      <div class="card h-100 shadow-sm">
        <div class="card-body">
          <h5 class="card-title">Associe-se</h5>
          <p class="card-text">Acesse a área do associado para atualizar cadastro e pagar mensalidades.</p>
          <a href="login.html" class="btn btn-outline-primary w-100 w-md-auto">Entrar</a>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- (4) PARCEIROS -->
<section class="bg-body-secondary py-5">
  <div class="container">
    <h2 class="h4 mb-4">Parceiros</h2>
    <div class="row g-4 align-items-center">
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/logoEquusProNutrition.png?v=ccbmg-2025-09-10b" alt="Equus ProNutrition" loading="lazy">
      </div>
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/logoMuralhadePedra.jpg?v=ccbmg-2025-09-10b" alt="Muralha de Pedra" loading="lazy">
      </div>
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/logoJulioAndrade.png?v=ccbmg-2025-09-10b" alt="Julio Andrade" loading="lazy">
      </div>
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/logoCalabar.png?v=ccbmg-2025-09-10b" alt="Calabar" loading="lazy">
      </div>
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/duducatireiro.jpg?v=ccbmg-2025-09-10b" alt="Dudu Catireiro" loading="lazy">
      </div>
      <div class="col-6 col-md-3 d-flex justify-content-center">
        <img class="img-fluid partner-logo" src="assets/parceiro/camaramunicipal.png?v=ccbmg-2025-09-10b" alt="Câmara Municipal" loading="lazy">
      </div>
    </div>
  </div>
</section>

<!-- (5) REDES SOCIAIS & CONTATO -->
<section class="py-5">
  <div class="container">

    <!-- Título da seção no mobile -->
    <h2 class="h4 mb-3 d-lg-none">Redes Sociais & Contato</h2>

    <!-- Linha dos títulos só no desktop -->
    <div class="d-none d-lg-flex align-items-baseline justify-content-between mb-3">
      <h2 class="h4 mb-0">Redes Sociais & Contato</h2>
      <h2 class="h4 mb-0">📍 Onde estamos</h2>
    </div>

    <div class="row g-4">
      <!-- Coluna Redes sociais -->
      <div class="col-lg-6">
        <div class="p-4 border rounded-3 h-100">
          <h3 class="h5 mb-3">Siga o Clube</h3>
          <ul class="list-unstyled mb-0">
            <li class="mb-2">Instagram: <a href="https://www.instagram.com/clube_do_cavalo_de_bonfim_mg/" target="_blank" rel="noopener">/@clubedocavalobonfimmg</a></li>
            <li class="mb-2">E-mail: <a href="mailto:contato@clubedocavalo.com.br">contato@clubedocavalo.com.br</a></li>
            <li class="mb-2">WhatsApp: <a href="https://wa.me/5531991297695" target="_blank" rel="noopener">+55 (31) 99129-7695</a></li>
          </ul>
        </div>
      </div>

      <!-- Coluna Onde estamos -->
      <div class="col-lg-6">
        <!-- Título visível só no mobile -->
        <h2 class="h4 mb-3 d-lg-none">📍 Onde estamos</h2>

        <div class="p-4 border rounded-3 h-100">
          <p class="h6 mb-2">Antiga Escola Melo Viana</p>
          <p class="mb-2">Rua Doutor Melo Viana, número 183 - Sala 08</p>
          <p class="mb-2">Bairro Centro, Bonfim</p>
          <p class="mb-3">CEP: 35480-000</p>
          <div class="ratio ratio-16x9">
            <img src="assets/img/meloviana.png?v=ccbmg-2025-09-10b" alt="Mapa de Bonfim MG"
                 class="w-100 h-100" style="object-fit:cover; border-radius:.5rem;" loading="lazy">
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<footer class="mt-5 py-4 bg-body-tertiary border-top">
  <div class="container d-flex flex-column flex-md-row justify-content-between align-items-center gap-2">
    <div><strong>Clube do Cavalo - Bonfim MG</strong> — Promovendo a cultura equestre.</div>
    <div class="text-secondary small text-center text-md-end">© 2025 Clube do Cavalo - Bonfim MG. Todos os direitos reservados.</div>
  </div>
</footer>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>

<!-- Não redirecionar aqui; apenas lidar com o Dashboard -->
<script>
  (function () {
    var el = document.getElementById('dashboardBtn');
    if (el) el.classList.add('d-none');
  })();
</script>

<script type="module">
  import { auth, db } from "./firebase.js";
  import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
  import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

  const dashboardBtn = document.getElementById("dashboardBtn");
  const hideDashboard = () => { if (dashboardBtn) dashboardBtn.classList.add("d-none"); };
  const showDashboard = () => { if (dashboardBtn) dashboardBtn.classList.remove("d-none"); };

  async function evaluateAndToggle(user) {
    if (!user) { hideDashboard(); return; }
    try {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      const data = snap.exists() ? snap.data() : {};
      const role   = String(data.role   || "").toLowerCase();
      const status = String(data.status || "").toLowerCase();
      const ativo  = !!data.ativo;
      const isBlocked = !ativo || status.includes("pendente");
      if (role === "admin" && !isBlocked) showDashboard();
      else hideDashboard();
    } catch (e) {
      console.error("Falha ao obter dados do usuário:", e);
      hideDashboard();
    }
  }

  onAuthStateChanged(auth, (user) => {
    hideDashboard();
    evaluateAndToggle(user);
  });

  // Revalida e atualiza se a página veio do back/forward cache
  window.addEventListener("pageshow", (ev) => {
    const fromBFCache = ev.persisted || (performance?.getEntriesByType?.("navigation")[0]?.type === "back_forward");
    hideDashboard();
    evaluateAndToggle(auth.currentUser || null);
    if (fromBFCache) location.reload();
  });

  // Defesa extra
  setTimeout(() => evaluateAndToggle(auth.currentUser || null), 1000);
</script>
</body>
</html>
