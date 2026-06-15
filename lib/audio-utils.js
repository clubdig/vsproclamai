const fs = require('fs');
const path = require('path');

// ── WAV Reading ──────────────────────────────────────────────────────

function readWav(filePath) {
  const buffer = fs.readFileSync(filePath);
  const header = parseWavHeader(buffer);
  const data = extractAudioData(buffer, header);
  return { header, data, sampleRate: header.sampleRate, channels: header.numChannels, bitsPerSample: header.bitsPerSample };
}

function parseWavHeader(buffer) {
  const header = {};
  header.riff = buffer.toString('ascii', 0, 4);
  header.fileSize = buffer.readUInt32LE(4);
  header.wave = buffer.toString('ascii', 8, 12);
  header.fmt = buffer.toString('ascii', 12, 16);
  header.fmtSize = buffer.readUInt32LE(16);
  header.audioFormat = buffer.readUInt16LE(20);
  header.numChannels = buffer.readUInt16LE(22);
  header.sampleRate = buffer.readUInt32LE(24);
  header.byteRate = buffer.readUInt32LE(28);
  header.blockAlign = buffer.readUInt16LE(32);
  header.bitsPerSample = buffer.readUInt16LE(34);

  // Find data chunk
  let offset = 36;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      header.dataOffset = offset + 8;
      header.dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  return header;
}

function extractAudioData(buffer, header) {
  const numSamples = Math.floor(header.dataSize / (header.bitsPerSample / 8));
  const samplesPerChannel = Math.floor(numSamples / header.numChannels);
  const Float32Array = require('typedarray-polyfill');
  const left = new Float32Array(samplesPerChannel);
  const right = new Float32Array(samplesPerChannel);

  for (let i = 0; i < samplesPerChannel; i++) {
    const idx = header.dataOffset + i * header.numChannels * (header.bitsPerSample / 8);
    if (header.bitsPerSample === 16) {
      const l = buffer.readInt16LE(idx);
      const r = header.numChannels > 1 ? buffer.readInt16LE(idx + 2) : l;
      left[i] = l / 32768;
      right[i] = r / 32768;
    } else if (header.bitsPerSample === 24) {
      const l = (buffer[idx] | (buffer[idx + 1] << 8) | (buffer[idx + 2] << 16)) / 8388608;
      const r = header.numChannels > 1
        ? (buffer[idx + 3] | (buffer[idx + 4] << 8) | (buffer[idx + 5] << 16)) / 8388608
        : l;
      left[i] = l;
      right[i] = r;
    } else if (header.bitsPerSample === 32) {
      const l = buffer.readFloatLE(idx);
      const r = header.numChannels > 1 ? buffer.readFloatLE(idx + 4) : l;
      left[i] = l;
      right[i] = r;
    }
  }

  return { left, right };
}

// ── WAV Writing ──────────────────────────────────────────────────────

function writeWav(filePath, left, right, sampleRate = 44100, bitsPerSample = 16) {
  const numSamples = left.length;
  const numChannels = 2;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);

  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));

    if (bitsPerSample === 16) {
      buffer.writeInt16LE(Math.round(l * 32767), offset);
      buffer.writeInt16LE(Math.round(r * 32767), offset + 2);
      offset += 4;
    } else if (bitsPerSample === 32) {
      buffer.writeFloatLE(l, offset);
      buffer.writeFloatLE(r, offset + 4);
      offset += 8;
    }
  }

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ── Resampling (simple linear interpolation) ────────────────────────

function resample(left, right, srcRate, dstRate) {
  if (srcRate === dstRate) return { left, right };

  const ratio = srcRate / dstRate;
  const newLen = Math.floor(left.length / ratio);
  const newLeft = new Float32Array(newLen);
  const newRight = new Float32Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;

    newLeft[i] = left[idx] * (1 - frac) + (left[idx + 1] || 0) * frac;
    newRight[i] = right[idx] * (1 - frac) + (right[idx + 1] || 0) * frac;
  }

  return { left: newLeft, right: newRight };
}

// ── Stereo to Mono ───────────────────────────────────────────────────

function stereoToMono(left, right) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    mono[i] = (left[i] + right[i]) / 2;
  }
  return mono;
}

// ── Audio chunking for model input ───────────────────────────────────

function chunkAudio(left, right, chunkSize = 44100 * 8) {
  const totalSamples = left.length;
  const chunks = [];

  for (let start = 0; start < totalSamples; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalSamples);
    const chunkLeft = new Float32Array(end - start);
    const chunkRight = new Float32Array(end - start);

    for (let i = 0; i < end - start; i++) {
      chunkLeft[i] = left[start + i];
      chunkRight[i] = right[start + i];
    }

    chunks.push({ left: chunkLeft, right: chunkRight, start, end });
  }

  return chunks;
}

module.exports = { readWav, writeWav, resample, stereoToMono, chunkAudio };
