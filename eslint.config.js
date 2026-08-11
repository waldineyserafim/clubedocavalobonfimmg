// eslint.config.js — lint da camada de CÓDIGO REUTILIZÁVEL do projeto.
//
// Escopo deliberadamente restrito (ver docs/DEVELOPMENT.md e CLAUDE.md, Fase
// 3.8, "Decisões" — por que não lintamos tudo):
//   - functions/**/*.js  — todas as Cloud Functions (Node/CommonJS)
//   - firebase.js, tenant.config.js — núcleo compartilhado do CCBMG (browser/ESM)
//
// FORA do escopo, por decisão: os <script type="module"> inline dentro de
// cada admin_*.html/*.html. São dezenas de páginas com lógica específica de
// tela, nunca reutilizadas por outra página — lintar exigiria um plugin de
// HTML (eslint-plugin-html) e uma auditoria grande de código legado nunca
// escrito pensando em lint, com alto risco de só gerar ruído sem consertar
// bug nenhum de verdade. O lint mira onde o bug tem mais alcance: bibliotecas
// compartilhadas (auth, billing, tenant, Cloud Functions), não markup de tela.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'functions/lib/**/*.min.js',
      'assets/js/bootstrap.bundle.min.js',
      'playwright-report/**',
      'test-results/**',
      'prototypes/**',
      'manual-associados/**',
      'functions/firestore-debug.log',
    ],
  },

  // Cloud Functions — Node, CommonJS.
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off', // console.log/warn/error é o transporte de log oficial deste projeto (ver functions/index.js)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }], // catch {} silencioso é padrão deliberado em vários fail-safes deste projeto
    },
  },

  // Núcleo compartilhado do CCBMG servido no browser (ES Modules).
  {
    files: ['firebase.js', 'tenant.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
