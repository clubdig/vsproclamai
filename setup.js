// VSProclamai - Setup (Node.js puro, sem Python!)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log(`
╔══════════════════════════════════════════════════════╗
║    VSProclamai - Instalador (Node.js Edition)       ║
╚══════════════════════════════════════════════════════╝
`);

function run(cmd, label) {
  console.log(`\n📦 ${label}...`);
  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
    console.log(`✅ ${label} - OK`);
  } catch (e) {
    console.error(`❌ Falha: ${label}`);
  }
}

// 1. Deps
console.log('\n═══ FASE 1: Dependências Node.js ═══');
run('npm install', 'Instalando pacotes npm');

// 2. Estrutura
console.log('\n═══ FASE 2: Criando diretórios ═══');
['data/songs', 'data/stems', 'data/models', 'public'].forEach(d => {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
  console.log(`  📁 ${d}`);
});

// 3. Verificar se o modelo já existe
console.log('\n═══ FASE 3: Verificação do modelo ═══');
const modelPath = path.join(__dirname, 'data', 'models', 'htdemucs.onnx');
if (fs.existsSync(modelPath)) {
  console.log('✅ Modelo ONNX já presente');
} else {
  console.log('ℹ️  Modelo será baixado automaticamente na primeira separação (~172MB)');
}

// 4. Scripts
console.log('\n═══ FASE 4: Criando atalhos ═══');

fs.writeFileSync(path.join(__dirname, 'iniciar.bat'), `@echo off
title VSProclamai
echo ====================================
echo    VSProclamai - Iniciando...
echo ====================================
echo Acesse: http://localhost:3000
echo.
node server.js
pause
`);

fs.writeFileSync(path.join(__dirname, 'instalar.bat'), `@echo off
title VSProclamai - Instalar
echo Instalando VSProclamai...
call npm install
echo.
echo Instalacao concluida! Execute: iniciar.bat
pause
`);

console.log('  📄 iniciar.bat');
console.log('  📄 instalar.bat');

console.log(`
╔══════════════════════════════════════════════════════╗
║           Instalação Concluída!                      ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  ✅ Tudo em Node.js - SEM PYTHON necessário!         ║
║                                                      ║
║  Para iniciar:                                       ║
║    node server.js                                    ║
║    OU clique em iniciar.bat                          ║
║                                                      ║
║  Acesse: http://localhost:3000                       ║
║                                                      ║
║  Separação de stems:                                 ║
║    Modelo ONNX (~172MB) baixa automático             ║
║    Roda em CPU via ONNX Runtime                      ║
║                                                      ║
║  Download YouTube:                                   ║
║    Via ytdl-core (Node.js puro)                      ║
║                                                      ║
║  Opcional (para melhor conversão de áudio):          ║
║    - FFmpeg: winget install ffmpeg                   ║
╚══════════════════════════════════════════════════════╝
`);
