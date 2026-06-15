const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');
const { readWav, writeWav, resample, chunkAudio } = require('./audio-utils');
const { ensureModel } = require('./model-downloader');
const { StemSplitter } = require('./stem-splitter');

const SAMPLE_RATE = 44100;
const CHUNK_SAMPLES = SAMPLE_RATE * 4; // 4 segundos por chunk
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

class DemucsSeparator {
  constructor(options = {}) {
    this.modelPath = null;
    this.session = null;
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || console.log;
  }

  async initialize() {
    this.onLog('[Demucs] Inicializando...');
    this.modelPath = await ensureModel(this.onProgress);

    this.onLog('[Demucs] Carregando modelo ONNX...');
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    });

    this.onLog('[Demucs] Modelo carregado. Input:', this.session.inputNames, 'Output:', this.session.outputNames);
    return this;
  }

  preprocessAudio(left, right) {
    // Resample para 44.1kHz se necessário
    // Criar tensor [1, 2, samples] (batch, channels, samples)
    const minLen = Math.min(left.length, right.length);
    const trimmedLeft = left.slice(0, minLen);
    const trimmedRight = right.slice(0, minLen);

    // Normalizar
    const maxVal = Math.max(
      ...Array.from(trimmedLeft).map(Math.abs),
      ...Array.from(trimmedRight).map(Math.abs),
      1
    );

    const normalizedLeft = new Float32Array(trimmedLeft.length);
    const normalizedRight = new Float32Array(trimmedRight.length);
    for (let i = 0; i < minLen; i++) {
      normalizedLeft[i] = trimmedLeft[i] / maxVal;
      normalizedRight[i] = trimmedRight[i] / maxVal;
    }

    return { left: normalizedLeft, right: normalizedRight, normalizationFactor: maxVal };
  }

  async separateChunk(chunkLeft, chunkRight) {
    const samples = chunkLeft.length;

    // Criar input tensor [batch=1, channels=2, samples]
    const inputData = new Float32Array(2 * samples);
    for (let i = 0; i < samples; i++) {
      inputData[i] = chunkLeft[i];             // channel 0 (left)
      inputData[samples + i] = chunkRight[i];  // channel 1 (right)
    }

    const inputTensor = new ort.Tensor('float32', inputData, [1, 2, samples]);
    const feeds = {};
    feeds[this.session.inputNames[0]] = inputTensor;

    const results = await this.session.run(feeds);
    const outputTensor = results[this.session.outputNames[0]];

    // Output shape: [batch, sources, channels, samples]
    const outputData = outputTensor.data;
    const numSources = STEM_NAMES.length;
    const outputSamples = Math.floor(outputData.length / (numSources * 2));

    const stems = {};
    for (let s = 0; s < numSources; s++) {
      const stemLeft = new Float32Array(outputSamples);
      const stemRight = new Float32Array(outputSamples);
      const offset = s * outputSamples * 2;

      for (let i = 0; i < outputSamples; i++) {
        stemLeft[i] = outputData[offset + i];
        stemRight[i] = outputData[offset + outputSamples + i];
      }

      stems[STEM_NAMES[s]] = { left: stemLeft, right: stemRight };
    }

    return stems;
  }

  async separateFile(inputPath, outputDir) {
    if (!this.session) await this.initialize();

    this.onLog(`[Demucs] Processando: ${inputPath}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Ler áudio
    const audio = readWav(inputPath);
    this.onLog(`[Demucs] Áudio: ${audio.sampleRate}Hz, ${audio.channels}ch, ${audio.data.left.length} samples`);

    // Preprocessar
    const { left, right, normalizationFactor } = this.preprocessAudio(audio.data.left, audio.data.right);
    this.onLog(`[Demucs] Normalizado. Amostras: ${left.length}`);

    // Dividir em chunks
    const chunks = chunkAudio(left, right, CHUNK_SAMPLES);
    this.onLog(`[Demucs] ${chunks.length} chunks de ${CHUNK_SAMPLES} samples`);

    // Processar cada chunk
    const stemBuffers = {};
    for (const name of STEM_NAMES) {
      stemBuffers[name] = { left: [], right: [] };
    }

    for (let c = 0; c < chunks.length; c++) {
      this.onProgress((c + 1) / chunks.length);
      this.onLog(`[Demucs] Chunk ${c + 1}/${chunks.length}...`);

      const result = await this.separateChunk(chunks[c].left, chunks[c].right);

      for (const name of STEM_NAMES) {
        stemBuffers[name].left.push(result[name].left);
        stemBuffers[name].right.push(result[name].right);
      }
    }

    // Concatenar chunks e salvar
    const outputFiles = [];
    for (const name of STEM_NAMES) {
      const concatenatedLeft = concatArrays(stemBuffers[name].left);
      const concatenatedRight = concatArrays(stemBuffers[name].right);

      // Desnormalizar
      for (let i = 0; i < concatenatedLeft.length; i++) {
        concatenatedLeft[i] *= normalizationFactor;
        concatenatedRight[i] *= normalizationFactor;
      }

      const outPath = path.join(outputDir, `${name}.wav`);
      writeWav(outPath, concatenatedLeft, concatenatedRight, SAMPLE_RATE, 16);
      outputFiles.push(outPath);
      this.onLog(`[Demucs] ✓ ${name}.wav (${(concatenatedLeft.length / SAMPLE_RATE).toFixed(1)}s)`);
    }

    this.onLog('[Demucs] Separação concluída!');

    // ── Fase 2: Dividir em 8 pistas ──────────────────────────────
    this.onLog('[StemSplitter] Iniciando separação avançada em 8 pistas...');

    const splitter = new StemSplitter(SAMPLE_RATE);
    const finalDir = path.join(outputDir, '..', 'stems_final', path.basename(outputDir));
    fs.mkdirSync(finalDir, { recursive: true });

    await splitter.processStems(outputDir, finalDir);

    // Mover resultado para o diretório principal
    const finalStems = fs.readdirSync(finalDir).filter(f => f.endsWith('.wav'));
    for (const file of finalStems) {
      const src = path.join(finalDir, file);
      const dst = path.join(outputDir, file);
      fs.copyFileSync(src, dst);
    }

    this.onLog(`[OK] ${finalStems.length} pistas finais prontas!`);
    return outputFiles;
  }
}

function concatArrays(arrays) {
  const totalLen = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Float32Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

module.exports = { DemucsSeparator };
