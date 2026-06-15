const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { DemucsSeparator } = require('./lib/demucs-separator');
const { YouTubeDownloader } = require('./lib/youtube-downloader');
const { MusicDB } = require('./lib/database');
const { GoogleDrive } = require('./lib/google-drive');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stems', express.static(path.join(__dirname, 'data', 'stems')));
app.use('/songs', express.static(path.join(__dirname, 'data', 'songs')));

const DATA_DIR = path.join(__dirname, 'data');
const STEMS_DIR = path.join(DATA_DIR, 'stems');
const SONGS_AUDIO_DIR = path.join(DATA_DIR, 'songs');

// ── Inicializar banco e Drive ─────────────────────────────────────────
const db = new MusicDB();
const drive = new GoogleDrive();

// Migrar dados antigos do JSON para SQLite
function migrateOldSongs() {
  const oldPath = path.join(DATA_DIR, 'songs.json');
  if (fs.existsSync(oldPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      if (old.songs && old.songs.length > 0) {
        for (const song of old.songs) {
          const existing = db.getSong(song.id);
          if (!existing) {
            db.createSong(song);
          }
        }
        console.log(`[DB] Migradas ${old.songs.length} músicas do JSON antigo`);
      }
    } catch (e) {
      console.log('[DB] Nenhuma migração necessária');
    }
  }
}
migrateOldSongs();

// ── API: Músicas (SQLite) ─────────────────────────────────────────────

app.get('/api/songs', (req, res) => {
  const { q, category } = req.query;
  let songs;
  if (q) {
    songs = db.searchSongs(q);
  } else if (category) {
    songs = db.getAllSongs().filter(s => s.category === category);
  } else {
    songs = db.getAllSongs();
  }
  res.json({ songs });
});

app.get('/api/songs/:id', (req, res) => {
  const song = db.getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Música não encontrada' });
  res.json(song);
});

app.post('/api/songs', (req, res) => {
  try {
    const song = db.createSong(req.body);
    res.json(song);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/songs/:id', (req, res) => {
  const song = db.updateSong(req.params.id, req.body);
  if (!song) return res.status(404).json({ error: 'Música não encontrada' });
  res.json(song);
});

app.delete('/api/songs/:id', (req, res) => {
  db.deleteSong(req.params.id);
  res.json({ ok: true });
});

// ── API: Setlists (Repertórios) ───────────────────────────────────────

app.get('/api/setlists', (req, res) => {
  const { q, date } = req.query;
  let setlists;
  if (q) {
    setlists = db.searchSetlists(q);
  } else if (date) {
    setlists = db.getSetlistsByDate(date);
  } else {
    setlists = db.getAllSetlists();
  }
  res.json({ setlists });
});

app.get('/api/setlists/:id', (req, res) => {
  const setlist = db.getSetlist(req.params.id);
  if (!setlist) return res.status(404).json({ error: 'Repertório não encontrado' });
  res.json(setlist);
});

app.post('/api/setlists', (req, res) => {
  try {
    const setlist = db.createSetlist(req.body);
    res.json(setlist);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/setlists/:id', (req, res) => {
  const setlist = db.updateSetlist(req.params.id, req.body);
  if (!setlist) return res.status(404).json({ error: 'Repertório não encontrado' });
  res.json(setlist);
});

app.delete('/api/setlists/:id', (req, res) => {
  db.deleteSetlist(req.params.id);
  res.json({ ok: true });
});

app.post('/api/setlists/:id/songs', (req, res) => {
  const { songId, position, key, notes } = req.body;
  const setlist = db.addSongToSetlist(req.params.id, songId, position || 0, key, notes);
  res.json(setlist);
});

app.delete('/api/setlists/:id/songs/:songId', (req, res) => {
  const setlist = db.removeSongFromSetlist(req.params.id, req.params.songId);
  res.json(setlist);
});

app.put('/api/setlists/:id/reorder', (req, res) => {
  const { songIds } = req.body;
  const setlist = db.reorderSetlist(req.params.id, songIds);
  res.json(setlist);
});

// ── API: Google Drive ─────────────────────────────────────────────────

app.get('/api/drive/status', (req, res) => {
  res.json({
    configured: drive.isConfigured(),
    authenticated: drive.isAuthenticated()
  });
});

app.get('/api/drive/auth-url', (req, res) => {
  if (!drive.isConfigured()) {
    return res.status(400).json({ error: 'Credenciais Google não configuradas. Coloque google-credentials.json em data/' });
  }
  try {
    const url = drive.getAuthUrl();
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/drive/auth', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código obrigatório' });
  try {
    await drive.authenticate(code);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/drive/search', async (req, res) => {
  const { q, folder } = req.query;
  try {
    let files;
    if (folder) {
      files = await drive.getFolderContents(folder);
    } else if (q) {
      files = await drive.searchFiles(`name contains '${q}'`);
    } else {
      files = await drive.searchAudioFiles();
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/drive/folders', async (req, res) => {
  try {
    const folders = await drive.listMusicFolders();
    res.json({ folders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/drive/sync', async (req, res) => {
  try {
    const result = await drive.syncToDatabase(db);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/drive/cache', (req, res) => {
  const { q } = req.query;
  let files;
  if (q) {
    files = db.searchDriveFiles(q);
  } else {
    files = db.getDriveFilesByFolder();
  }
  res.json({ files });
});

app.delete('/api/drive/cache', (req, res) => {
  db.clearDriveCache();
  res.json({ ok: true });
});

// ── API: Stems ────────────────────────────────────────────────────────

app.get('/api/stems/:songId', (req, res) => {
  const stemDir = path.join(STEMS_DIR, req.params.songId);
  if (!fs.existsSync(stemDir)) return res.json({ stems: [] });
  const stems = fs.readdirSync(stemDir).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
  res.json({ stems });
});

// ── API: Download e Separação ──────────────────────────────────────────

app.post('/api/download', async (req, res) => {
  const { songId, url } = req.body;
  if (!songId || !url) return res.status(400).json({ error: 'songId e url obrigatórios' });

  const outputDir = path.join(SONGS_AUDIO_DIR, songId);
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const downloader = new YouTubeDownloader({
      onLog: (msg) => console.log(msg),
      onProgress: (p) => console.log(`Download: ${(p * 100).toFixed(0)}%`)
    });
    const result = await downloader.download(url, outputDir);

    // Atualizar duração no banco
    if (result.duration) {
      db.updateSong(songId, { duration: result.duration });
    }

    res.json({ success: true, title: result.title, duration: result.duration });
  } catch (e) {
    console.error('[Download Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/separate', async (req, res) => {
  const { songId } = req.body;
  if (!songId) return res.status(400).json({ error: 'songId obrigatório' });

  const inputDir = path.join(SONGS_AUDIO_DIR, songId);
  const outputDir = path.join(STEMS_DIR, songId);

  try {
    if (!fs.existsSync(inputDir)) {
      return res.status(400).json({ error: 'Áudio não encontrado. Faça o download primeiro.' });
    }

    const audioFiles = fs.readdirSync(inputDir).filter(f =>
      f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.webm')
    );

    if (audioFiles.length === 0) {
      return res.status(400).json({ error: 'Nenhum áudio encontrado para separar' });
    }

    const inputFile = path.join(inputDir, audioFiles[0]);

    console.log(`[Separate] Processando: ${audioFiles[0]}`);

    const separator = new DemucsSeparator({
      onLog: (msg) => console.log(msg),
      onProgress: (p) => console.log(`Separação: ${(p * 100).toFixed(0)}%`)
    });

    await separator.separateFile(inputFile, outputDir);

    db.updateSong(songId, { stemsReady: true });

    res.json({ success: true, message: '8 pistas separadas com sucesso!' });
  } catch (e) {
    console.error('[Separation Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/model-status', (req, res) => {
  const { isModelDownloaded } = require('./lib/model-downloader');
  res.json({ downloaded: isModelDownloaded() });
});

// ── Multiplayer (Socket.IO) ──────────────────────────────────────────

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[VSProclamai] Conectado: ${socket.id}`);

  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { leader: socket.id, currentSong: null, playing: false, position: 0, bpm: 120, members: [] });
    }
    const room = rooms.get(roomId);
    room.members.push({ id: socket.id, username, isLeader: room.leader === socket.id });
    socket.emit('room-state', { ...room, yourId: socket.id });
    io.to(roomId).emit('member-joined', { username, members: room.members });
  });

  socket.on('play', ({ roomId, position }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;
    room.playing = true;
    room.position = position || 0;
    io.to(roomId).emit('sync-play', { position: room.position, timestamp: Date.now() });
  });

  socket.on('pause', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;
    room.playing = false;
    io.to(roomId).emit('sync-pause', { position: room.position });
  });

  socket.on('seek', ({ roomId, position }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;
    room.position = position;
    io.to(roomId).emit('sync-seek', { position, timestamp: Date.now() });
  });

  socket.on('set-bpm', ({ roomId, bpm }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;
    room.bpm = bpm;
    io.to(roomId).emit('bpm-changed', { bpm });
  });

  socket.on('select-song', ({ roomId, song }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;
    room.currentSong = song;
    room.position = 0;
    room.playing = false;
    io.to(roomId).emit('song-changed', { song });
  });

  socket.on('volume-change', ({ roomId, stem, volume, username }) => {
    socket.to(roomId).emit('volume-changed', { stem, volume, username });
  });

  socket.on('metronome-click', ({ roomId, beat }) => {
    socket.to(roomId).emit('metronome-sync', { beat, timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const idx = room.members.findIndex(m => m.id === socket.id);
      if (idx !== -1) {
        const member = room.members[idx];
        room.members.splice(idx, 1);
        io.to(roomId).emit('member-left', { username: member.username, members: room.members });
        if (room.leader === socket.id && room.members.length > 0) {
          room.leader = room.members[0].id;
          room.members[0].isLeader = true;
          io.to(roomId).emit('new-leader', { leaderId: room.leader });
        }
        if (room.members.length === 0) rooms.delete(roomId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         VSProclamai - Node.js Edition                ║
║                                                      ║
║  http://localhost:${PORT}                              ║
║                                                      ║
║  ✓ SQLite Database                                   ║
║  ✓ Google Drive Integration                          ║
║  ✓ ONNX Runtime (8 pistas)                           ║
║  ✓ Multiplayer WebSocket                             ║
╚══════════════════════════════════════════════════════╝
  `);
});
