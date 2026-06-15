const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const MODEL_DIR = path.join(__dirname, '..', 'data', 'models');
const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/main/vocals.onnx';

// Alternativas caso o modelo acima não funcione
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
  return fs.existsSync(modelPath) && fs.statSync(modelPath).size > 10 * 1024 * 1024;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { headers: { 'User-Agent': 'VSProclamai/1.0' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && totalSize) {
          onProgress(downloaded / totalSize);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });

    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Timeout'));
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
        console.log('[Demucs] Modelo baixado com sucesso!');
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
