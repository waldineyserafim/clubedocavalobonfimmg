#!/usr/bin/env node
// scripts/check-syntax.js — substitui "build" neste projeto.
//
// CCBMG não tem bundler/transpiler (GitHub Pages serve os arquivos direto,
// ver CLAUDE.md regra 4) e Cloud Functions roda o .js como está — não existe
// artefato de build de verdade pra compilar. O equivalente honesto de "build
// quebrado" aqui é "algum .js não é nem sintaticamente válido", então é isso
// que este script checa: `node --check` em todo .js versionado relevante
// (o mesmo mecanismo usado manualmente antes de cada deploy nas fases
// anteriores). Roda em milissegundos, zero dependência nova.

const { execFileSync } = require('child_process');
const { readdirSync, statSync } = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', '.git', 'playwright-report', 'test-results', 'prototypes', 'manual-associados']);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      collectJsFiles(full, out);
    } else if (entry.endsWith('.js') && !entry.endsWith('.min.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = collectJsFiles(ROOT);
let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.error(`✗ ${path.relative(ROOT, file)}`);
    console.error(e.stderr ? e.stderr.toString() : e.message);
  }
}

console.log(`${files.length - failures}/${files.length} arquivos .js sintaticamente válidos.`);
if (failures > 0) {
  console.error(`\n${failures} arquivo(s) com erro de sintaxe.`);
  process.exit(1);
}
