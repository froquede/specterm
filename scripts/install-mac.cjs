#!/usr/bin/env node
// Installs the freshly built macOS app into /Applications.
// Run after `npm run build:electron:mac` (or use `npm run install:mac`,
// which builds first). Quits any running instance, removes the old copy,
// and copies the new .app over.
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'build-output', 'mac-arm64', 'Specterm.app');
const DEST = '/Applications/Specterm.app';

if (!fs.existsSync(SRC)) {
  console.error(`\n✗ Build não encontrado em:\n  ${SRC}\n`);
  console.error('Rode `npm run build:electron:mac` primeiro (ou use `npm run install:mac`).\n');
  process.exit(1);
}

console.log('› Fechando instâncias abertas do Specterm...');
try {
  execSync('osascript -e \'quit app "Specterm"\'', { stdio: 'ignore' });
} catch {
  // app não estava aberto — segue o jogo
}

console.log(`› Removendo versão antiga em ${DEST}...`);
fs.rmSync(DEST, { recursive: true, force: true });

console.log('› Copiando build novo para /Applications...');
execFileSync('cp', ['-R', SRC, DEST]);

console.log('\n✓ Instalado. Abra com:  open -a Specterm\n');
