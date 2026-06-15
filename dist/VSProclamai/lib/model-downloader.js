const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MODEL_DIR = path.join(__dirname, '..', 'data', 'models');
const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';

const FALLBACK_MODELS = [
  'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx'
];

function ensureModelDir() {
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }
}

function getModelPath() {
  ensureModelDir();
  return path.join(MODEL_DIR, 'htdemucs.onnx');
}

function isModelDownloaded() {
  const modelPath = getModelPath();
  return fs.existsSync(modelPath) && fs.statSync(modelPath).size > 50 * 1024 * 1024;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const curlArgs = [
      '-L',
      '--max-time', '300',
      '--retry', '3',
      '-o', destPath,
      url
    ];

    if (onProgress) onProgress(0);

    const proc = execFile('curl', curlArgs, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return reject(new Error(`curl failed: ${error.message}`));
      }

      if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 10 * 1024 * 1024) {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return reject(new Error('Downloaded file is too small or missing'));
      }

      if (onProgress) onProgress(1);
      resolve(destPath);
    });
  });
}

async function ensureModel(onProgress) {
  if (isModelDownloaded()) {
    console.log('[Demucs] Modelo já baixado');
    return getModelPath();
  }

  console.log('[Demucs] Baixando modelo ONNX (~172MB)...');
  ensureModelDir();

  const urls = [MODEL_URL, ...FALLBACK_MODELS];

  for (const url of urls) {
    try {
      console.log(`[Demucs] Tentando: ${url}`);
      await downloadFile(url, getModelPath(), onProgress);
      if (isModelDownloaded()) {
        const size = fs.statSync(getModelPath()).size;
        console.log(`[Demucs] Modelo baixado: ${(size / 1024 / 1024).toFixed(1)}MB`);
        return getModelPath();
      }
    } catch (e) {
      console.log(`[Demucs] Falha: ${e.message}`);
      if (fs.existsSync(getModelPath())) fs.unlinkSync(getModelPath());
    }
  }

  throw new Error('Não foi possível baixar o modelo. Verifique sua conexão.');
}

module.exports = { ensureModel, isModelDownloaded, getModelPath };
