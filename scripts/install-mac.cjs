#!/usr/bin/env node
// Installs the freshly built macOS app into /Applications.
// Run after `npm run build:electron:mac` (or use `npm run install:mac`,
// which builds first). Quits any running instance, removes the old copy,
// and copies the new .app over.
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// electron-builder writes the arm64 app to mac-arm64/ and the x64 one to mac/.
// Install the one that matches this machine.
const OUT_DIR = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const SRC = path.resolve(__dirname, '..', 'build-output', OUT_DIR, 'Specterm.app');
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
