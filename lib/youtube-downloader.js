const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class YouTubeDownloader {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || console.log;
  }

  async download(url, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    this.onLog(`[YouTube] Baixando: ${url}`);

    try {
      // Baixar como áudio
      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title.replace(/[^\w\s-]/g, '').substring(0, 80);
      const duration = parseInt(info.videoDetails.lengthSeconds);

      this.onLog(`[YouTube] Título: ${title}`);
      this.onLog(`[YouTube] Duração: ${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`);

      // Stream de áudio
      const stream = ytdl(url, {
        quality: 'highestaudio',
        filter: 'audioonly'
      });

      const outputPath = path.join(outputDir, 'audio.webm');
      const fileStream = fs.createWriteStream(outputPath);

      return new Promise((resolve, reject) => {
        let downloadedBytes = 0;
        const totalBytes = parseInt(info.videoDetails.lengthSeconds) * 20000; // estimativa

        stream.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          this.onProgress(downloadedBytes / totalBytes);
        });

        stream.pipe(fileStream);

        fileStream.on('finish', async () => {
          this.onLog('[YouTube] Download concluído');

          // Converter para WAV usando ffmpeg (se disponível)
          const wavPath = path.join(outputDir, 'audio.wav');
          try {
            await this.convertToWav(outputPath, wavPath);
            this.onLog('[YouTube] Convertido para WAV');
            resolve({ title, duration, outputPath: wavPath });
          } catch (e) {
            this.onLog('[YouTube] FFmpeg não disponível, usando WebM');
            resolve({ title, duration, outputPath });
          }
        });

        stream.on('error', reject);
        fileStream.on('error', reject);
      });
    } catch (error) {
      throw new Error(`Falha ao baixar: ${error.message}`);
    }
  }

  async convertToWav(inputPath, outputPath) {
    try {
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-y', outputPath
      ]);
      return true;
    } catch (e) {
      // Tentar com outro caminho do ffmpeg
      try {
        await execFileAsync('ffmpeg.exe', [
          '-i', inputPath,
          '-acodec', 'pcm_s16le',
          '-ar', '44100',
          '-ac', '2',
          '-y', outputPath
        ]);
        return true;
      } catch (e2) {
        throw new Error('FFmpeg não encontrado');
      }
    }
  }
}

module.exports = { YouTubeDownloader };
