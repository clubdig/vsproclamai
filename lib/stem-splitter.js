const fs = require('fs');
const path = require('path');
const { readWav, writeWav } = require('./audio-utils');

// ── Frequências de corte (Hz) ────────────────────────────────────────
const FREQ = {
  SUB_BASS: 80,
  BASS_LOW: 250,
  GUITAR_LOW: 200,
  GUITAR_HIGH: 5000,
  SYNTH_LOW: 300,
  SYNTH_HIGH: 6000,
  VOCAL_LOW: 150,
  VOCAL_HIGH: 4000,
  BACK_VOCAL_LOW: 200,
  BACK_VOCAL_HIGH: 3500,
  KEYS_LOW: 200,
  KEYS_HIGH: 4000,
  PIANO_LOW: 100,
  PIANO_HIGH: 5000,
  FX_LOW: 6000
};

class StemSplitter {
  constructor(sampleRate = 44100) {
    this.sr = sampleRate;
  }

  // ── Filtros DSP ──────────────────────────────────────────────────

  lowPass(samples, cutoff, sr) {
    const rc = 1.0 / (cutoff * 2 * Math.PI);
    const dt = 1.0 / sr;
    const alpha = dt / (rc + dt);
    const out = new Float32Array(samples.length);
    out[0] = samples[0];
    for (let i = 1; i < samples.length; i++) {
      out[i] = out[i - 1] + alpha * (samples[i] - out[i - 1]);
    }
    return out;
  }

  highPass(samples, cutoff, sr) {
    const lp = this.lowPass(samples, cutoff, sr);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] - lp[i];
    }
    return out;
  }

  bandPass(samples, lowCut, highCut, sr) {
    const hp = this.highPass(samples, lowCut, sr);
    return this.lowPass(hp, highCut, sr);
  }

  // ── Processamento espectral (simplificado via filtros cascata) ───

  extractBand(left, right, lowHz, highHz) {
    const outL = this.bandPass(left, lowHz, highHz, this.sr);
    const outR = this.bandPass(right, lowHz, highHz, this.sr);
    return { left: outL, right: outR };
  }

  // ── Análise de energia por banda ──────────────────────────────────

  bandEnergy(samples, startSample, windowSize) {
    let energy = 0;
    const end = Math.min(startSample + windowSize, samples.length);
    for (let i = startSample; i < end; i++) {
      energy += samples[i] * samples[i];
    }
    return energy / (end - startSample);
  }

  // ── Separar vocal lead vs backvocal ──────────────────────────────

  splitVocals(vocalsLeft, vocalsRight) {
    const len = vocalsLeft.length;
    const leadL = new Float32Array(len);
    const leadR = new Float32Array(len);
    const backL = new Float32Array(len);
    const backR = new Float32Array(len);

    // Vocal lead: banda central (150-4000Hz) - mais "seco"
    const leadBand = this.extractBand(vocalsLeft, vocalsRight, FREQ.VOCAL_LOW, FREQ.VOCAL_HIGH);

    // Back vocal: harmônicos e reverberação (200-3500Hz, com mais "espaco")
    const backBand = this.extractBand(vocalsLeft, vocalsRight, FREQ.BACK_VOCAL_LOW, FREQ.BACK_VOCAL_HIGH);

    // Estimar separação usando correlação entre canais
    // Vocal lead tende a estar mais no centro, backvocal mais espalhado
    const windowSize = Math.floor(this.sr * 0.02); // 20ms windows

    for (let i = 0; i < len; i += windowSize) {
      const end = Math.min(i + windowSize, len);

      // Calcular energia dos harmônicos vs fundamental
      const lowBand = this.bandEnergy(vocalsLeft, i, windowSize);
      const midBand = this.bandEnergy(leadBand.left, i, windowSize);
      const highBand = this.bandEnergy(backBand.left, i, windowSize);

      // Razão harmônicos/fundamental
      const harmonicRatio = highBand / (midBand + 0.0001);

      for (let j = i; j < end; j++) {
        if (harmonicRatio > 0.3) {
          // Mais harmônicos = back vocal
          backL[j] = vocalsLeft[j] * 0.7;
          backR[j] = vocalsRight[j] * 0.7;
          leadL[j] = vocalsLeft[j] * 0.3;
          leadR[j] = vocalsRight[j] * 0.3;
        } else {
          // Mais fundamental = lead vocal
          leadL[j] = vocalsLeft[j] * 0.85;
          leadR[j] = vocalsRight[j] * 0.85;
          backL[j] = vocalsLeft[j] * 0.15;
          backR[j] = vocalsRight[j] * 0.15;
        }
      }
    }

    return {
      vocal: { left: leadL, right: leadR },
      backvocals: { left: backL, right: backR }
    };
  }

  // ── Separar other em guitarra, synth, keys, piano, fx ────────────

  splitOther(otherLeft, otherRight) {
    const len = otherLeft.length;

    // Guitar: 200-5000Hz com harmônicos característicos
    const guitar = this.extractBand(otherLeft, otherRight, FREQ.GUITAR_LOW, FREQ.GUITAR_HIGH);

    // Synth: 300-6000Hz (mais agudo que guitar)
    const synth = this.extractBand(otherLeft, otherRight, FREQ.SYNTH_LOW, FREQ.SYNTH_HIGH);

    // Keys: 200-4000Hz
    const keys = this.extractBand(otherLeft, otherRight, FREQ.KEYS_LOW, FREQ.KEYS_HIGH);

    // Piano: 100-5000Hz (mais amplo)
    const piano = this.extractBand(otherLeft, otherRight, FREQ.PIANO_LOW, FREQ.PIANO_HIGH);

    // FX: acima de 6000Hz (efeitos, pratos, airy)
    const fx = this.extractBand(otherLeft, otherRight, FREQ.FX_LOW, this.sr / 2);

    // Normalizar e reduzir sobreposição
    const guitarL = new Float32Array(len);
    const guitarR = new Float32Array(len);
    const synthL = new Float32Array(len);
    const synthR = new Float32Array(len);
    const keysL = new Float32Array(len);
    const keysR = new Float32Array(len);
    const pianoL = new Float32Array(len);
    const pianoR = new Float32Array(len);
    const fxL = new Float32Array(len);
    const fxR = new Float32Array(len);

    const windowSize = Math.floor(this.sr * 0.05); // 50ms

    for (let i = 0; i < len; i += windowSize) {
      const end = Math.min(i + windowSize, len);

      // Analisar characterística espectral do window
      const guitarE = this.bandEnergy(guitar.left, i, windowSize);
      const synthE = this.bandEnergy(synth.left, i, windowSize);
      const keysE = this.bandEnergy(keys.left, i, windowSize);
      const pianoE = this.bandEnergy(piano.left, i, windowSize);
      const fxE = this.bandEnergy(fx.left, i, windowSize);

      const totalE = guitarE + synthE + keysE + pianoE + fxE + 0.0001;

      for (let j = i; j < end; j++) {
        // Peso baseado na energia relativa
        const gW = guitarE / totalE;
        const sW = synthE / totalE;
        const kW = keysE / totalE;
        const pW = pianoE / totalE;
        const fW = fxE / totalE;

        guitarL[j] = otherLeft[j] * gW * 1.2;
        guitarR[j] = otherRight[j] * gW * 1.2;
        synthL[j] = otherLeft[j] * sW * 1.1;
        synthR[j] = otherRight[j] * sW * 1.1;
        keysL[j] = otherLeft[j] * kW * 1.0;
        keysR[j] = otherRight[j] * kW * 1.0;
        pianoL[j] = otherLeft[j] * pW * 1.0;
        pianoR[j] = otherRight[j] * pW * 1.0;
        fxL[j] = otherLeft[j] * fW * 1.3;
        fxR[j] = otherRight[j] * fW * 1.3;
      }
    }

    return {
      guitar1: { left: guitarL, right: guitarR },
      guitar2: { left: this.duplicateShift(guitarL, guitarR, 0.003), right: this.duplicateShift(guitarR, guitarL, 0.003) },
      synth: { left: synthL, right: synthR },
      keyboard: { left: keysL, right: keysR },
      piano: { left: pianoL, right: pianoR },
      fx: { left: fxL, right: fxR }
    };
  }

  // ── Duplicar e deslocar para criar "segunda guitarra" ────────────

  duplicateShift(left, right, delaySec) {
    const delaySamples = Math.floor(delaySec * this.sr);
    const out = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      const srcIdx = i - delaySamples;
      out[i] = srcIdx >= 0 ? left[srcIdx] * 0.6 : 0;
    }
    // Adicionar variação de fase
    for (let i = 0; i < out.length; i += 3) {
      out[i] *= -1;
    }
    return out;
  }

  // ── Pipeline principal: 4 stems → 8 stems ────────────────────────

  async processStems(stemsDir, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    console.log('[StemSplitter] Processando stems em 8 pistas...');
    console.log('[StemSplitter] Canais: Vocal, Back Vocals, Guitar 1, Guitar 2, Synth, Keyboard, Piano, FX');

    // Ler stems do Demucs
    const vocalsFile = path.join(stemsDir, 'vocals.wav');
    const otherFile = path.join(stemsDir, 'other.wav');
    const drumsFile = path.join(stemsDir, 'drums.wav');
    const bassFile = path.join(stemsDir, 'bass.wav');

    const results = {};

    // 1. Separar vocals → vocal + backvocals
    if (fs.existsSync(vocalsFile)) {
      console.log('[StemSplitter] Separando vocal/backvocals...');
      const vocals = readWav(vocalsFile);
      const split = this.splitVocals(vocals.data.left, vocals.data.right);
      results.vocal = split.vocal;
      results.backvocals = split.backvocals;
    }

    // 2. Separar other → guitar1, guitar2, synth, keyboard, piano, fx
    if (fs.existsSync(otherFile)) {
      console.log('[StemSplitter] Separando other em 6 pistas...');
      const other = readWav(otherFile);
      const split = this.splitOther(other.data.left, other.data.right);
      Object.assign(results, split);
    }

    // 3. Manter drums e bass como estão
    if (fs.existsSync(drumsFile)) {
      const drums = readWav(drumsFile);
      results.drums = { left: drums.data.left, right: drums.data.right };
    }
    if (fs.existsSync(bassFile)) {
      const bass = readWav(bassFile);
      results.bass = { left: bass.data.left, right: bass.data.right };
    }

    // Salvar todas as pistas
    const stemNames = Object.keys(results);
    for (const name of stemNames) {
      const outPath = path.join(outputDir, `${name}.wav`);
      writeWav(outPath, results[name].left, results[name].right, 44100, 16);
      const duration = (results[name].left.length / 44100).toFixed(1);
      console.log(`  ✓ ${name}.wav (${duration}s)`);
    }

    console.log(`[StemSplitter] ${stemNames.length} pistas salvas em: ${outputDir}`);
    return stemNames;
  }
}

module.exports = { StemSplitter };
