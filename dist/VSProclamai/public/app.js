// ═══════════════════════════════════════════════════════════════════════
// VSProclamai - App Principal
// ═══════════════════════════════════════════════════════════════════════

let socket = null;
let roomId = null;
let username = '';
let isLeader = false;

// Audio
let audioContext = null;
const stems = {};
let currentSong = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let selectedSongId = null;

// Metronome
let metronomeActive = false;
let metronomeInterval = null;
let bpm = 120;
let timeSignature = 4;
let currentBeat = 0;
let clickAudioCtx = null;
let accentEnabled = true;

// Solo/Mute
let soloActive = {};
let muteActive = {};

// Database
let allSongs = [];
let allSetlists = [];
let currentSetlist = null;

// ── Inicialização ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSongs();
  initAudioContext();
});

function initAudioContext() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  clickAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// ── Socket.IO ────────────────────────────────────────────────────────

function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    notify('Conectado ao servidor');
  });

  socket.on('room-state', (state) => {
    isLeader = state.leader === state.yourId;
    document.getElementById('roomInfo').style.display = 'flex';
    document.getElementById('roomName').textContent = `Sala: ${roomId}`;
    updateMemberList(state.members);
  });

  socket.on('member-joined', ({ username: name, members }) => {
    notify(`${name} entrou na sala`);
    updateMemberList(members);
  });

  socket.on('member-left', ({ username: name, members }) => {
    notify(`${name} saiu da sala`);
    updateMemberList(members);
  });

  socket.on('new-leader', ({ leaderId }) => {
    isLeader = leaderId === socket.id;
    if (isLeader) notify('Você agora é o líder da sala');
  });

  socket.on('sync-play', ({ position, timestamp }) => {
    if (isLeader) return;
    const delay = (Date.now() - timestamp) / 1000;
    startPlayback(position + delay);
    document.getElementById('playBtn').textContent = '⏸';
  });

  socket.on('sync-pause', ({ position }) => {
    if (isLeader) return;
    pausePlayback(position);
    document.getElementById('playBtn').textContent = '▶';
  });

  socket.on('sync-seek', ({ position }) => {
    if (isLeader) return;
    pauseOffset = position;
    if (isPlaying) startPlayback(position);
  });

  socket.on('song-changed', ({ song }) => {
    currentSong = song;
    updateNowPlaying(song);
    loadStems(song.id);
  });

  socket.on('bpm-changed', ({ bpm: newBpm }) => {
    bpm = newBpm;
    document.getElementById('bpmInput').value = bpm;
    if (metronomeActive) restartMetronome();
  });

  socket.on('volume-changed', ({ stem, volume }) => {
    if (stems[stem]) {
      stems[stem].gain.gain.value = volume / 100;
    }
  });

  socket.on('metronome-sync', ({ beat }) => {
    highlightBeat(beat);
    playClickSound(beat === 0 && accentEnabled);
  });
}

// ── Song Library (SQLite) ─────────────────────────────────────────────

async function loadSongs() {
  try {
    const res = await fetch('/api/songs');
    const data = await res.json();
    allSongs = data.songs || [];
    renderSongList(allSongs);
  } catch (e) {
    console.error('Erro ao carregar músicas:', e);
  }
}

function renderSongList(songs) {
  const list = document.getElementById('songList');
  if (!songs || songs.length === 0) {
    list.innerHTML = '<p class="empty-state">Nenhuma música. Clique "+ Nova" para adicionar.</p>';
    return;
  }
  list.innerHTML = songs.map(s => `
    <div class="song-item ${selectedSongId === s.id ? 'active' : ''}"
         onclick="selectSong('${s.id}')" data-id="${s.id}">
      <div class="song-name">${s.title}</div>
      <div class="song-artist">${s.artist || ''} • ${s.key || ''} • ${s.timeSignature || '4/4'}</div>
      <div class="song-bpm">${s.bpm} BPM • ${s.category || ''}</div>
      <div class="song-stems ${s.stemsReady ? '' : 'not-ready'}">${s.stemsReady ? '✓ 10 pistas prontas' : '○ Sem stems'}</div>
    </div>
  `).join('');
}

async function searchSongsDB() {
  const q = document.getElementById('searchSongs').value;
  try {
    const res = await fetch(`/api/songs?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSongList(data.songs);
  } catch (e) {
    console.error(e);
  }
}

async function selectSong(id) {
  selectedSongId = id;
  const song = allSongs.find(s => s.id === id);
  if (!song) {
    const res = await fetch(`/api/songs/${id}`);
    if (!res.ok) return;
    currentSong = await res.json();
  } else {
    currentSong = song;
  }

  updateNowPlaying(currentSong);

  if (isLeader && socket) {
    socket.emit('select-song', { roomId, song: currentSong });
  }

  await loadStems(id);

  bpm = currentSong.bpm || 120;
  document.getElementById('bpmInput').value = bpm;
  timeSignature = parseInt(currentSong.timeSignature) || 4;
  document.getElementById('timeSig').value = currentSong.timeSignature || '4/4';

  renderSongList(allSongs);
}

// ── Tab System ────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));

  event.target.classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  if (tabName === 'setlists') loadSetlists();
  if (tabName === 'drive') loadDriveStatus();
}

// ── Setlists (Repertórios) ───────────────────────────────────────────

async function loadSetlists() {
  try {
    const res = await fetch('/api/setlists');
    const data = await res.json();
    allSetlists = data.setlists || [];
    renderSetlistList(allSetlists);
  } catch (e) {
    console.error(e);
  }
}

function renderSetlistList(setlists) {
  const list = document.getElementById('setlistList');
  if (!setlists || setlists.length === 0) {
    list.innerHTML = '<p class="empty-state">Nenhum repertório. Clique "+ Novo" para criar.</p>';
    return;
  }
  list.innerHTML = setlists.map(s => `
    <div class="setlist-item" onclick="openSetlist('${s.id}')">
      <div class="setlist-name">${s.name}</div>
      <div class="setlist-date">${s.eventDate || 'Sem data'} ${s.eventTime || ''}</div>
      <div class="setlist-info">${s.songs ? s.songs.length : 0} músicas • ${s.location || ''}</div>
    </div>
  `).join('');
}

async function searchSetlists() {
  const q = document.getElementById('searchSetlist').value;
  try {
    const res = await fetch(`/api/setlists?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSetlistList(data.setlists);
  } catch (e) { console.error(e); }
}

async function searchSetlistsByDate() {
  const date = document.getElementById('searchDate').value;
  if (!date) return loadSetlists();
  try {
    const res = await fetch(`/api/setlists?date=${date}`);
    const data = await res.json();
    renderSetlistList(data.setlists);
  } catch (e) { console.error(e); }
}

function showAddSetlistModal() {
  document.getElementById('addSetlistModal').style.display = 'flex';
}

async function addSetlist() {
  const data = {
    name: document.getElementById('newSetlistName').value,
    eventDate: document.getElementById('newSetlistDate').value,
    eventTime: document.getElementById('newSetlistTime').value,
    location: document.getElementById('newSetlistLocation').value,
    description: document.getElementById('newSetlistDesc').value
  };
  if (!data.name) return notify('Nome obrigatório', true);

  await fetch('/api/setlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  closeModals();
  loadSetlists();
  notify('Repertório criado!');
}

async function openSetlist(id) {
  const res = await fetch(`/api/setlists/${id}`);
  if (!res.ok) return notify('Erro ao carregar repertório', true);
  currentSetlist = await res.json();

  if (allSongs.length === 0) {
    const songsRes = await fetch('/api/songs');
    const songsData = await songsRes.json();
    allSongs = songsData.songs || [];
  }

  document.getElementById('setlistDetailTitle').textContent = currentSetlist.name;
  document.getElementById('setlistDetailInfo').innerHTML = `
    📅 ${currentSetlist.eventDate || 'Sem data'} ${currentSetlist.eventTime || ''}<br>
    📍 ${currentSetlist.location || 'Sem local'}<br>
    📝 ${currentSetlist.description || ''}
  `;

  renderSetlistSongs();

  const select = document.getElementById('addSongToSetlistSelect');
  select.innerHTML = '<option value="">Adicionar música...</option>' +
    allSongs.map(s => `<option value="${s.id}">${s.title} - ${s.artist || ''}</option>`).join('');

  document.getElementById('setlistDetailModal').style.display = 'flex';
}

function renderSetlistSongs() {
  const list = document.getElementById('setlistSongsList');
  if (!currentSetlist.songs || currentSetlist.songs.length === 0) {
    list.innerHTML = '<p class="empty-state">Nenhuma música neste repertório</p>';
    return;
  }
  list.innerHTML = currentSetlist.songs.map((s, i) => `
    <div class="setlist-song-item">
      <span class="song-pos">${i + 1}</span>
      <span class="song-info">${s.title} - ${s.artist || ''} ${s.overrideKey ? `(${s.overrideKey})` : ''}</span>
      <button class="remove-btn" onclick="removeSongFromSetlist('${s.id}')" title="Remover">✕</button>
    </div>
  `).join('');
}

async function addSongToCurrentSetlist() {
  const songId = document.getElementById('addSongToSetlistSelect').value;
  if (!songId) return notify('Selecione uma música', true);
  if (!currentSetlist) return notify('Repertório não carregado', true);

  const position = currentSetlist.songs ? currentSetlist.songs.length : 0;

  const res = await fetch(`/api/setlists/${currentSetlist.id}/songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songId, position })
  });

  if (!res.ok) return notify('Erro ao adicionar música', true);
  currentSetlist = await res.json();
  renderSetlistSongs();
  notify('Música adicionada ao repertório');
}

async function removeSongFromSetlist(songId) {
  if (!currentSetlist) return;
  const res = await fetch(`/api/setlists/${currentSetlist.id}/songs/${songId}`, { method: 'DELETE' });
  currentSetlist = await res.json();
  renderSetlistSongs();
}

// ── Google Drive ──────────────────────────────────────────────────────

async function loadDriveStatus() {
  try {
    const res = await fetch('/api/drive/status');
    const status = await res.json();
    const el = document.getElementById('driveStatus');

    if (status.configured && status.authenticated) {
      el.className = 'drive-status connected';
      el.textContent = '✓ Conectado ao Google Drive';
      loadDriveCache();
    } else if (status.configured) {
      el.className = 'drive-status disconnected';
      el.innerHTML = '⚠ Drive configurado mas não autenticado. <a href="#" onclick="showDriveAuth()">Autenticar</a>';
    } else {
      el.className = 'drive-status error';
      el.innerHTML = '✗ Credenciais não encontradas. Coloque <code>google-credentials.json</code> em <code>data/</code>';
    }
  } catch (e) {
    console.error(e);
  }
}

function showDriveAuth() {
  document.getElementById('driveAuthModal').style.display = 'flex';
  getDriveAuthUrl();
}

async function getDriveAuthUrl() {
  try {
    const res = await fetch('/api/drive/auth-url');
    const data = await res.json();
    if (data.url) {
      document.getElementById('driveAuthUrl').style.display = 'block';
      document.getElementById('driveAuthLink').href = data.url;
    }
  } catch (e) {
    notify('Erro ao obter URL de autenticação', true);
  }
}

async function authenticateDrive() {
  const code = document.getElementById('driveAuthCode').value;
  if (!code) return notify('Cole o código de autorização', true);

  try {
    const res = await fetch('/api/drive/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (res.ok) {
      closeModals();
      loadDriveStatus();
      notify('Google Drive conectado!');
    }
  } catch (e) {
    notify('Falha na autenticação', true);
  }
}

async function searchDriveFiles() {
  const q = document.getElementById('searchDrive').value;
  if (!q) return loadDriveCache();

  try {
    const res = await fetch(`/api/drive/cache?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderDriveList(data.files);
  } catch (e) { console.error(e); }
}

async function loadDriveCache() {
  try {
    const res = await fetch('/api/drive/cache');
    const data = await res.json();
    const files = typeof data.files === 'object' && !Array.isArray(data.files)
      ? Object.values(data.files).flat()
      : data.files || [];
    renderDriveList(files);
  } catch (e) { console.error(e); }
}

function renderDriveList(files) {
  const list = document.getElementById('driveList');
  if (!files || files.length === 0) {
    list.innerHTML = '<p class="empty-state">Nenhum arquivo. Clique "Sincronizar" para buscar do Drive.</p>';
    return;
  }
  list.innerHTML = files.map(f => {
    const icon = f.mimeType?.includes('audio') ? '🎵' : f.mimeType?.includes('folder') ? '📁' : '📄';
    return `
      <div class="drive-item" onclick="selectDriveFile('${f.id}')">
        <span class="drive-icon">${icon}</span>
        <span class="drive-name">${f.name}</span>
        <span class="drive-folder">${f.folderName || ''}</span>
      </div>
    `;
  }).join('');
}

async function syncDrive() {
  notify('Sincronizando com Google Drive...');
  try {
    const res = await fetch('/api/drive/sync', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    notify(`${data.count || 0} arquivos sincronizados`);
    loadDriveCache();
  } catch (e) {
    notify(`Erro: ${e.message}`, true);
  }
}

function selectDriveFile(fileId) {
  notify(`Arquivo Drive: ${fileId}`);
}

function updateNowPlaying(song) {
  document.getElementById('currentSongTitle').textContent = song.title;
  document.getElementById('currentSongMeta').textContent =
    `${song.artist} • ${song.bpm} BPM • ${song.key || ''} • ${song.timeSignature || '4/4'}`;
  document.getElementById('totalTime').textContent = formatTime(song.duration || 0);
}

// ── Stem Loading & Playback ─────────────────────────────────────────

const ALL_STEMS = ['vocal', 'backvocals', 'guitar1', 'guitar2', 'synth', 'keyboard', 'piano', 'fx', 'drums', 'bass'];

async function loadStems(songId) {
  // Parar stems anteriores
  Object.values(stems).forEach(s => {
    if (s.source) { try { s.source.stop(); } catch(e) {} }
  });
  Object.keys(stems).forEach(k => delete stems[k]);

  try {
    const res = await fetch(`/api/stems/${songId}`);
    const data = await res.json();

    if (data.stems.length === 0) {
      notify('Nenhum stem encontrado. Faça a separação primeiro.', true);
      return;
    }

    for (const name of ALL_STEMS) {
      const stemFile = data.stems.find(f => f.includes(name));
      if (!stemFile) continue;

      const response = await fetch(`/stems/${songId}/${stemFile}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      stems[name] = {
        buffer: audioBuffer,
        source: null,
        gain: audioContext.createGain(),
        pan: audioContext.createStereoPanner(),
        muted: false,
        solo: false
      };
      stems[name].gain.connect(stems[name].pan);
      stems[name].pan.connect(audioContext.destination);
    }

    notify(`Stems: ${Object.keys(stems).join(', ')}`);
  } catch (e) {
    console.error('Erro ao carregar stems:', e);
    notify('Erro ao carregar stems', true);
  }
}

// ── Transport Controls ──────────────────────────────────────────────

function togglePlay() {
  if (!currentSong) return;

  if (isPlaying) {
    pausePlayback();
    if (isLeader && socket) socket.emit('pause', { roomId });
  } else {
    startPlayback(pauseOffset);
    if (isLeader && socket) socket.emit('play', { roomId, position: pauseOffset });
  }
}

function startPlayback(offset = 0) {
  if (audioContext.state === 'suspended') audioContext.resume();

  Object.entries(stems).forEach(([name, stem]) => {
    if (stem.source) { try { stem.source.stop(); } catch(e) {} }
    stem.source = audioContext.createBufferSource();
    stem.source.buffer = stem.buffer;
    stem.source.connect(stem.gain);
    stem.source.loop = true;
    stem.source.start(0, offset % stem.buffer.duration);
  });

  isPlaying = true;
  startTime = audioContext.currentTime - offset;
  document.getElementById('playBtn').textContent = '⏸';
  requestAnimationFrame(updateTimeDisplay);
}

function pausePlayback(position) {
  const pos = position !== undefined ? position : audioContext.currentTime - startTime;
  pauseOffset = pos;

  Object.values(stems).forEach(stem => {
    if (stem.source) { try { stem.source.stop(); } catch(e) {} }
  });

  isPlaying = false;
  document.getElementById('playBtn').textContent = '▶';
}

function stopPlayback() {
  pauseOffset = 0;
  Object.values(stems).forEach(stem => {
    if (stem.source) { try { stem.source.stop(); } catch(e) {} }
  });
  isPlaying = false;
  document.getElementById('playBtn').textContent = '▶';
  document.getElementById('currentTime').textContent = '0:00';
  document.getElementById('positionBar').value = 0;
}

function skipForward() {
  if (!isPlaying) return;
  pauseOffset += 10;
  if (isPlaying) startPlayback(pauseOffset);
}

function skipBackward() {
  if (!isPlaying) return;
  pauseOffset = Math.max(0, pauseOffset - 10);
  if (isPlaying) startPlayback(pauseOffset);
}

function seekTo(value) {
  if (!currentSong) return;
  const pos = (value / 100) * (currentSong.duration || 300);
  pauseOffset = pos;
  if (isPlaying) startPlayback(pos);
  if (isLeader && socket) socket.emit('seek', { roomId, position: pos });
}

function updateTimeDisplay() {
  if (!isPlaying) return;
  const elapsed = audioContext.currentTime - startTime;
  document.getElementById('currentTime').textContent = formatTime(elapsed);

  if (currentSong && currentSong.duration) {
    document.getElementById('positionBar').value = (elapsed / currentSong.duration) * 100;
  }

  requestAnimationFrame(updateTimeDisplay);
}

// ── Mixer ────────────────────────────────────────────────────────────

function setStemVolume(stemName, value) {
  if (stems[stemName]) {
    const vol = value / 100;
    stems[stemName].gain.gain.value = vol;
    document.getElementById(`vol-${stemName}`).textContent = `${value}%`;
    if (socket) socket.emit('volume-change', { roomId, stem: stemName, volume: value, username });
  }
}

function toggleMute(stemName) {
  if (!stems[stemName]) return;
  muteActive[stemName] = !muteActive[stemName];
  stems[stemName].gain.gain.value = muteActive[stemName] ? 0 : 1;
  const btn = document.querySelector(`.mixer-channel[data-stem="${stemName}"] .mute-btn`);
  btn.classList.toggle('active');
  document.getElementById(`vol-${stemName}`).textContent = muteActive[stemName] ? '0%' : '100%';
}

function toggleSolo(stemName) {
  if (!stems[stemName]) return;
  soloActive[stemName] = !soloActive[stemName];

  const anySolo = Object.values(soloActive).some(v => v);

  Object.entries(stems).forEach(([name, stem]) => {
    if (anySolo) {
      stem.gain.gain.value = soloActive[name] ? 1 : 0;
    } else {
      stem.gain.gain.value = muteActive[name] ? 0 : 1;
    }
  });

  const btn = document.querySelector(`.mixer-channel[data-stem="${stemName}"] .solo-btn`);
  btn.classList.toggle('active');
}

// ── Metronome ────────────────────────────────────────────────────────

function toggleMetronome() {
  metronomeActive = !metronomeActive;
  document.getElementById('metronomeBtn').textContent =
    metronomeActive ? 'Desativar Metrônomo' : 'Ativar Metrônomo';

  if (metronomeActive) {
    startMetronome();
  } else {
    stopMetronome();
  }
}

function startMetronome() {
  stopMetronome();
  currentBeat = 0;
  const interval = (60 / bpm) * 1000;

  highlightBeat(currentBeat);
  playClickSound(currentBeat === 0 && accentEnabled);

  metronomeInterval = setInterval(() => {
    currentBeat = (currentBeat + 1) % timeSignature;
    highlightBeat(currentBeat);
    playClickSound(currentBeat === 0 && accentEnabled);

    if (socket) {
      socket.emit('metronome-click', { roomId, beat: currentBeat });
    }
  }, interval);
}

function stopMetronome() {
  if (metronomeInterval) clearInterval(metronomeInterval);
  metronomeInterval = null;
  document.querySelectorAll('.beat-dot').forEach(d => d.classList.remove('active'));
}

function restartMetronome() {
  if (metronomeActive) startMetronome();
}

function playClickSound(accent) {
  if (!clickAudioCtx) clickAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (clickAudioCtx.state === 'suspended') clickAudioCtx.resume();

  const osc = clickAudioCtx.createOscillator();
  const gain = clickAudioCtx.createGain();
  osc.connect(gain);
  gain.connect(clickAudioCtx.destination);

  osc.frequency.value = accent ? 1200 : 800;
  gain.gain.value = accent ? 0.5 : 0.3;

  const now = clickAudioCtx.currentTime;
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

  osc.start(now);
  osc.stop(now + 0.05);
}

function highlightBeat(beat) {
  document.querySelectorAll('.beat-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === beat);
    dot.classList.toggle('accent', i === 0);
  });
}

function changeBPM(delta) {
  bpm = Math.max(30, Math.min(300, bpm + delta));
  document.getElementById('bpmInput').value = bpm;
  if (metronomeActive) restartMetronome();
  if (isLeader && socket) socket.emit('set-bpm', { roomId, bpm });
}

function setBPM(value) {
  bpm = Math.max(30, Math.min(300, parseInt(value) || 120));
  document.getElementById('bpmInput').value = bpm;
  if (metronomeActive) restartMetronome();
  if (isLeader && socket) socket.emit('set-bpm', { roomId, bpm });
}

function setTimeSignature(value) {
  const parts = value.split('/');
  timeSignature = parseInt(parts[0]);
  // Recriar dots
  const container = document.getElementById('beatDots');
  container.innerHTML = '';
  for (let i = 0; i < timeSignature; i++) {
    const dot = document.createElement('div');
    dot.className = 'beat-dot';
    dot.dataset.beat = i;
    container.appendChild(dot);
  }
  if (metronomeActive) restartMetronome();
}

function toggleAccent() {
  accentEnabled = document.getElementById('clickAccent').checked;
}

// ── Room System ──────────────────────────────────────────────────────

function showConnectModal() {
  document.getElementById('connectModal').style.display = 'flex';
}

function joinRoom() {
  roomId = document.getElementById('inputRoomId').value.trim() || `room-${Math.random().toString(36).substr(2, 6)}`;
  username = document.getElementById('inputUsername').value.trim() || 'Músico';

  connectSocket();
  setTimeout(() => {
    socket.emit('join-room', { roomId, username });
  }, 500);

  closeModals();
  notify(`Entrou na sala: ${roomId}`);
}

function updateMemberList(members) {
  const list = document.getElementById('memberList');
  document.getElementById('memberCount').textContent = `${members.length} membros`;

  list.innerHTML = members.map(m => `
    <div class="member-item ${m.isLeader ? 'leader' : ''}">
      <span>${m.isLeader ? '👑' : '🎵'}</span>
      <span>${m.username}</span>
      <span style="color:var(--text-secondary);font-size:0.75em;">${m.isLeader ? 'Líder' : ''}</span>
    </div>
  `).join('');
}

// ── Modals ───────────────────────────────────────────────────────────

function showAddSongModal() {
  document.getElementById('addSongModal').style.display = 'flex';
}

function showDownloadModal() {
  const select = document.getElementById('downloadSongSelect');
  fetch('/api/songs').then(r => r.json()).then(data => {
    select.innerHTML = data.songs.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
  });
  document.getElementById('downloadModal').style.display = 'flex';
}

function showSeparateModal() {
  const select = document.getElementById('separateSongSelect');
  fetch('/api/songs').then(r => r.json()).then(data => {
    select.innerHTML = data.songs.map(s =>
      `<option value="${s.id}">${s.title} ${s.stemsReady ? '✓' : ''}</option>`
    ).join('');
  });
  document.getElementById('separateModal').style.display = 'flex';
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
}

let ytInfoTimeout = null;

function onYouTubeUrlChange() {
  const url = document.getElementById('newSongUrl').value;
  if (ytInfoTimeout) clearTimeout(ytInfoTimeout);
  if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) return;
  
  document.getElementById('addSongProgress').style.display = 'block';
  document.getElementById('addSongStatus').textContent = 'Buscando informações do vídeo...';
  document.getElementById('addSongProgressFill').style.width = '30%';

  ytInfoTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/youtube/info?url=${encodeURIComponent(url)}`);
      const info = await res.json();
      if (info.error) throw new Error(info.error);
      document.getElementById('newSongTitle').value = info.title || '';
      document.getElementById('newSongArtist').value = info.artist || '';
      document.getElementById('addSongProgressFill').style.width = '60%';
      document.getElementById('addSongStatus').textContent = `Encontrado: ${info.title} (${info.artist})`;
    } catch (e) {
      document.getElementById('addSongStatus').textContent = 'Não foi possível buscar info';
      document.getElementById('addSongProgressFill').style.width = '0%';
    }
  }, 800);
}

async function addSong() {
  const url = document.getElementById('newSongUrl').value;
  const title = document.getElementById('newSongTitle').value;
  const artist = document.getElementById('newSongArtist').value;
  const bpm = parseInt(document.getElementById('newSongBpm').value) || 120;
  const key = document.getElementById('newSongKey').value;
  const timeSignature = document.getElementById('newSongTimeSig').value;
  const category = document.getElementById('newSongCategory').value;

  if (!url && !title) return notify('Informe o título ou o link do YouTube', true);

  if (url) {
    document.getElementById('addSongProgress').style.display = 'block';
    document.getElementById('addSongBtn').disabled = true;
    document.getElementById('addSongBtn').textContent = 'Processando...';
    document.getElementById('addSongStatus').textContent = 'Baixando e separando... (pode levar alguns minutos)';
    document.getElementById('addSongProgressFill').style.width = '50%';

    try {
      const res = await fetch('/api/add-and-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist, bpm, key, timeSignature, youtubeUrl: url, category })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      document.getElementById('addSongProgressFill').style.width = '100%';
      document.getElementById('addSongStatus').textContent = 'Música criada! Processamento em andamento...';

      closeModals();
      loadSongs();
      if (data.song) selectSong(data.song.id);
      notify('Música criada! Download e separação rodando em background.');
    } catch (e) {
      document.getElementById('addSongStatus').textContent = `Erro: ${e.message}`;
      document.getElementById('addSongProgressFill').style.width = '0%';
      notify(`Erro: ${e.message}`, true);
    } finally {
      document.getElementById('addSongBtn').disabled = false;
      document.getElementById('addSongBtn').textContent = 'Adicionar';
    }
  } else {
    await fetch('/api/songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist, bpm, key, timeSignature, youtubeUrl: '', category, duration: 0 })
    });
    closeModals();
    loadSongs();
    notify('Música adicionada!');
  }
}

async function startDownload() {
  const songId = document.getElementById('downloadSongSelect').value;
  const url = document.getElementById('downloadUrl').value;
  if (!url) return notify('URL é obrigatória', true);

  document.getElementById('downloadProgress').style.display = 'block';
  document.getElementById('downloadStatus').textContent = 'Baixando áudio...';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId, url })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    notify('Download concluído!');
    closeModals();
  } catch (e) {
    notify(`Erro: ${e.message}`, true);
  }
}

async function startSeparation() {
  const songId = document.getElementById('separateSongSelect').value;
  document.getElementById('separateProgress').style.display = 'block';
  document.getElementById('separateStatus').textContent = 'Processando com Demucs... (isso pode levar alguns minutos)';

  try {
    const res = await fetch('/api/separate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    notify('Separação concluída!');
    loadSongs();
    closeModals();
  } catch (e) {
    notify(`Erro: ${e.message}`, true);
  }
}

// ── Utilities ────────────────────────────────────────────────────────

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function notify(message, isError = false) {
  const el = document.getElementById('notification');
  el.textContent = message;
  el.className = 'notification show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'notification', 3000);
}

// Fechar modais com ESC
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModals();
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    togglePlay();
  }
});
