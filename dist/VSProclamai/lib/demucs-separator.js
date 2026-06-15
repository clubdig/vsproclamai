const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');
const { readWav, writeWav } = require('./audio-utils');
const { ensureModel } = require('./model-downloader');
const { StemSplitter } = require('./stem-splitter');

const SAMPLE_RATE = 44100;
const NFFT = 4096;
const HOP = 1024;
const FREQ_BINS = NFFT / 2;
const SEGMENT_SAMPLES = 343980;
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const tRe = curRe * re[i+j+half] - curIm * im[i+j+half];
        const tIm = curRe * im[i+j+half] + curIm * re[i+j+half];
        re[i+j+half] = re[i+j] - tRe;
        im[i+j+half] = im[i+j] - tIm;
        re[i+j] += tRe;
        im[i+j] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

function computeSTFT(signal, window) {
  const nSamples = signal.length;
  const nFrames = Math.floor((nSamples - NFFT) / HOP) + 1;
  const outRe = new Float32Array(nFrames * FREQ_BINS);
  const outIm = new Float32Array(nFrames * FREQ_BINS);
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP;
    for (let i = 0; i < NFFT; i++) {
      re[i] = signal[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < FREQ_BINS; k++) {
      outRe[f * FREQ_BINS + k] = re[k];
      outIm[f * FREQ_BINS + k] = im[k];
    }
  }
  return { re: outRe, im: outIm, nFrames };
}

function computeISTFT(outRe, outIm, window, outputSamples) {
  const nFrames = outRe.length / FREQ_BINS;
  const result = new Float32Array(outputSamples);
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);

  for (let f = 0; f < nFrames; f++) {
    for (let k = 0; k < FREQ_BINS; k++) {
      re[k] = outRe[f * FREQ_BINS + k];
      im[k] = outIm[f * FREQ_BINS + k];
    }
    for (let k = FREQ_BINS; k < NFFT; k++) {
      re[k] = re[NFFT - k];
      im[k] = -im[NFFT - k];
    }
    ifft(re, im);
    const start = f * HOP;
    for (let i = 0; i < NFFT && start + i < outputSamples; i++) {
      result[start + i] += re[i] * window[i];
    }
  }
  return result;
}

function makeTransitionWindow(segment, overlapFrac) {
  const transition = Math.floor(segment * overlapFrac);
  const w = new Float32Array(segment);
  for (let i = 0; i < transition; i++) {
    w[i] = i / transition;
    w[segment - 1 - i] = i / transition;
  }
  for (let i = transition; i < segment - transition; i++) w[i] = 1;
  return w;
}

class DemucsSeparator {
  constructor(options = {}) {
    this.modelPath = null;
    this.session = null;
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || console.log;
    this.window = hannWindow(NFFT);
    this.outputWindow = makeTransitionWindow(SEGMENT_SAMPLES, 0.25);
  }

  async initialize() {
    this.onLog('[Demucs] Inicializando...');
    this.modelPath = await ensureModel(this.onProgress);

    this.onLog('[Demucs] Carregando modelo ONNX...');
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    });

    this.onLog('[Demucs] Modelo carregado. Inputs:', this.session.inputNames, 'Outputs:', this.session.outputNames);
    return this;
  }

  prepareSTFTTensor(reData, imData, nFrames) {
    const tensorData = new Float32Array(4 * FREQ_BINS * nFrames);
    for (let f = 0; f < nFrames; f++) {
      for (let k = 0; k < FREQ_BINS; k++) {
        const idx = f * FREQ_BINS + k;
        tensorData[0 * FREQ_BINS * nFrames + idx] = reData[idx];
        tensorData[1 * FREQ_BINS * nFrames + idx] = imData[idx];
        tensorData[2 * FREQ_BINS * nFrames + idx] = reData[idx];
        tensorData[3 * FREQ_BINS * nFrames + idx] = imData[idx];
      }
    }
    return new ort.Tensor('float32', tensorData, [1, 4, FREQ_BINS, nFrames]);
  }

  async separateChunk(left, right) {
    const samples = left.length;
    const requiredFrames = 336;
    const paddedSamples = (requiredFrames - 1) * HOP + NFFT;

    const paddedLeft = new Float32Array(paddedSamples);
    const paddedRight = new Float32Array(paddedSamples);
    paddedLeft.set(left);
    paddedRight.set(right);

    const leftSTFT = computeSTFT(paddedLeft, this.window);
    const rightSTFT = computeSTFT(paddedRight, this.window);
    const nFrames = requiredFrames;

    const stftTensor = this.prepareSTFTTensor(
      this.mergeStereoSTFT(leftSTFT.re, rightSTFT.re, nFrames),
      this.mergeStereoSTFT(leftSTFT.im, rightSTFT.im, nFrames),
      nFrames
    );

    const inputData = new Float32Array(2 * samples);
    for (let i = 0; i < samples; i++) {
      inputData[i] = left[i];
      inputData[samples + i] = right[i];
    }
    const inputTensor = new ort.Tensor('float32', inputData, [1, 2, samples]);

    const feeds = {};
    feeds[this.session.inputNames[0]] = inputTensor;
    feeds[this.session.inputNames[1]] = stftTensor;

    const results = await this.session.run(feeds);
    const outputName = this.session.outputNames.find(n => n !== 'output') || this.session.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data;

    const stems = {};
    for (let s = 0; s < 4; s++) {
      const stemLeft = new Float32Array(samples);
      const stemRight = new Float32Array(samples);
      const offset = s * 2 * samples;
      for (let i = 0; i < samples; i++) {
        stemLeft[i] = outputData[offset + i];
        stemRight[i] = outputData[offset + samples + i];
      }
      stems[STEM_NAMES[s]] = { left: stemLeft, right: stemRight };
    }

    return stems;
  }

  mergeStereoSTFT(leftReIm, rightReIm, nFrames) {
    const out = new Float32Array(2 * FREQ_BINS * nFrames);
    out.set(leftReIm, 0);
    out.set(rightReIm, FREQ_BINS * nFrames);
    return out;
  }

  async separateFile(inputPath, outputDir) {
    if (!this.session) await this.initialize();

    this.onLog(`[Demucs] Processando: ${inputPath}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const audio = readWav(inputPath);
    this.onLog(`[Demucs] Áudio: ${audio.sampleRate}Hz, ${audio.channels}ch, ${audio.data.left.length} samples`);

    let left = audio.data.left;
    let right = audio.data.right;
    if (audio.channels === 1) right = new Float32Array(left);

    const totalSamples = left.length;
    const overlap = SEGMENT_SAMPLES / 4;
    const stride = SEGMENT_SAMPLES - overlap;
    const nChunks = Math.max(1, Math.ceil((totalSamples + stride - 1) / stride));
    this.onLog(`[Demucs] ${nChunks} chunks de ${SEGMENT_SAMPLES} samples (${(SEGMENT_SAMPLES / SAMPLE_RATE).toFixed(1)}s)`);

    const stemBuffers = {};
    for (const name of STEM_NAMES) {
      stemBuffers[name] = { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) };
    }
    const weight = new Float32Array(totalSamples);

    for (let c = 0; c < nChunks; c++) {
      this.onProgress((c + 1) / nChunks);
      this.onLog(`[Demucs] Chunk ${c + 1}/${nChunks}...`);

      const start = c * stride;
      const end = Math.min(start + SEGMENT_SAMPLES, totalSamples);
      let chunkLeft = left.slice(start, end);
      let chunkRight = right.slice(start, end);

      if (chunkLeft.length < SEGMENT_SAMPLES) {
        const paddedLeft = new Float32Array(SEGMENT_SAMPLES);
        const paddedRight = new Float32Array(SEGMENT_SAMPLES);
        paddedLeft.set(chunkLeft);
        paddedRight.set(chunkRight);
        chunkLeft = paddedLeft;
        chunkRight = paddedRight;
      }

      const result = await this.separateChunk(chunkLeft, chunkRight);
      const chunkLen = end - start;
      const w = this.outputWindow;

      for (const name of STEM_NAMES) {
        for (let i = 0; i < chunkLen; i++) {
          stemBuffers[name].left[start + i] += result[name].left[i] * w[i];
          stemBuffers[name].right[start + i] += result[name].right[i] * w[i];
        }
      }
      for (let i = 0; i < chunkLen; i++) {
        weight[start + i] += w[i];
      }
    }

    for (let i = 0; i < totalSamples; i++) {
      if (weight[i] > 1e-8) {
        for (const name of STEM_NAMES) {
          stemBuffers[name].left[i] /= weight[i];
          stemBuffers[name].right[i] /= weight[i];
        }
      }
    }

    const outputFiles = [];
    for (const name of STEM_NAMES) {
      const outPath = path.join(outputDir, `${name}.wav`);
      writeWav(outPath, stemBuffers[name].left, stemBuffers[name].right, SAMPLE_RATE, 16);
      outputFiles.push(outPath);
      this.onLog(`[Demucs] ✓ ${name}.wav (${(stemBuffers[name].left.length / SAMPLE_RATE).toFixed(1)}s)`);
    }

    this.onLog('[Demucs] Separação 4 stems concluída!');

    this.onLog('[StemSplitter] Iniciando separação avançada em 10 pistas...');
    const splitter = new StemSplitter(SAMPLE_RATE);
    const finalDir = path.join(outputDir, '..', 'stems_final', path.basename(outputDir));
    fs.mkdirSync(finalDir, { recursive: true });

    await splitter.processStems(outputDir, finalDir);

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

module.exports = { DemucsSeparator };
