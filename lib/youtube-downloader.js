const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const YTDLP_PATH = path.join(__dirname, '..', 'node_modules', '.bin', 'yt-dlp.exe');
const FFMPEG_PATH = require('ffmpeg-static');
const FFMPEG_DIR = path.dirname(FFMPEG_PATH);
const NODE_PATH = process.execPath;

function findYtdlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  return 'yt-dlp';
}

function baseArgs() {
  return [
    '--js-runtimes', `node:${NODE_PATH}`,
    '--no-warnings',
    '--no-check-certificates',
    '--ffmpeg-location', FFMPEG_DIR
  ];
}

function runYtdlpJson(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(findYtdlp(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
      resolve(stdout);
    });
    proc.on('error', reject);
  });
}

function runYtdlpDownload(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(findYtdlp(), args, { windowsHide: true });
    let stderr = '';
    proc.stdout.resume();
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
      resolve();
    });
    proc.on('error', reject);
  });
}

function extractJson(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in yt-dlp output');
  return JSON.parse(str.substring(start, end + 1));
}

class YouTubeDownloader {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || console.log;
  }

  async getInfo(url) {
    const stdout = await runYtdlpJson([...baseArgs(), '--dump-json', '--no-download', url]);
    const info = extractJson(stdout);
    return {
      title: info.title || '',
      artist: info.channel || info.uploader || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      description: info.description || ''
    };
  }

  async download(url, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    this.onLog(`[YouTube] Baixando: ${url}`);

    const wavPath = path.join(outputDir, 'audio.wav');

    await runYtdlpDownload([
      ...baseArgs(),
      '-x',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      '--postprocessor-args', 'ffmpeg:-acodec pcm_s16le -ar 44100 -ac 2',
      '-o', wavPath,
      '--no-playlist',
      url
    ]);

    this.onLog('[YouTube] Download concluído');

    if (!fs.existsSync(wavPath)) {
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith('audio.'));
      if (files.length > 0) {
        const oldPath = path.join(outputDir, files[0]);
        if (oldPath !== wavPath) fs.renameSync(oldPath, wavPath);
      }
    }

    let title = '', duration = 0;
    try {
      const info = await this.getInfo(url);
      title = info.title;
      duration = info.duration;
    } catch (e) {
      this.onLog('[YouTube] Info não disponível');
    }

    return { title, duration, outputPath: wavPath };
  }
}

module.exports = { YouTubeDownloader };
