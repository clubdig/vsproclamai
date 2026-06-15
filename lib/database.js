const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'vsproclamai.db');

class MusicDB {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT,
        bpm INTEGER DEFAULT 120,
        key TEXT,
        timeSignature TEXT DEFAULT '4/4',
        duration INTEGER DEFAULT 0,
        category TEXT DEFAULT 'Louvor',
        youtubeUrl TEXT,
        driveFileId TEXT,
        driveFileName TEXT,
        stemsReady INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS setlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        eventDate TEXT,
        eventTime TEXT,
        location TEXT,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS setlist_songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setlistId TEXT NOT NULL,
        songId TEXT NOT NULL,
        position INTEGER NOT NULL,
        key TEXT,
        notes TEXT,
        FOREIGN KEY (setlistId) REFERENCES setlists(id) ON DELETE CASCADE,
        FOREIGN KEY (songId) REFERENCES songs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS drive_files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mimeType TEXT,
        size INTEGER,
        createdTime TEXT,
        modifiedTime TEXT,
        webViewLink TEXT,
        thumbnailLink TEXT,
        folderName TEXT,
        cachedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);
      CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
      CREATE INDEX IF NOT EXISTS idx_songs_category ON songs(category);
      CREATE INDEX IF NOT EXISTS idx_setlists_date ON setlists(eventDate);
      CREATE INDEX IF NOT EXISTS idx_setlist_songs_setlist ON setlist_songs(setlistId);
      CREATE INDEX IF NOT EXISTS idx_drive_files_name ON drive_files(name);
    `);
  }

  // ── Songs CRUD ────────────────────────────────────────────────────

  getAllSongs() {
    return this.db.prepare('SELECT * FROM songs ORDER BY title').all();
  }

  getSong(id) {
    return this.db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  }

  searchSongs(query) {
    const q = `%${query}%`;
    return this.db.prepare(`
      SELECT * FROM songs
      WHERE title LIKE ? OR artist LIKE ? OR category LIKE ? OR key LIKE ?
      ORDER BY title
    `).all(q, q, q, q);
  }

  createSong(data) {
    const id = data.id || `song-${Date.now()}`;
    this.db.prepare(`
      INSERT INTO songs (id, title, artist, bpm, key, timeSignature, duration, category, youtubeUrl, driveFileId, driveFileName, stemsReady)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.title, data.artist || '', data.bpm || 120, data.key || '', data.timeSignature || '4/4', data.duration || 0, data.category || 'Louvor', data.youtubeUrl || '', data.driveFileId || '', data.driveFileName || '', data.stemsReady ? 1 : 0);
    return this.getSong(id);
  }

  updateSong(id, data) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'id') {
        fields.push(`${key} = ?`);
        values.push(key === 'stemsReady' ? (value ? 1 : 0) : value);
      }
    }
    fields.push("updatedAt = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE songs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getSong(id);
  }

  deleteSong(id) {
    this.db.prepare('DELETE FROM songs WHERE id = ?').run(id);
    return { ok: true };
  }

  // ── Setlists CRUD ─────────────────────────────────────────────────

  getAllSetlists() {
    return this.db.prepare('SELECT * FROM setlists ORDER BY eventDate DESC').all();
  }

  getSetlist(id) {
    const setlist = this.db.prepare('SELECT * FROM setlists WHERE id = ?').get(id);
    if (!setlist) return null;

    setlist.songs = this.db.prepare(`
      SELECT s.*, ss.position, ss.key as overrideKey, ss.notes
      FROM setlist_songs ss
      JOIN songs s ON s.id = ss.songId
      WHERE ss.setlistId = ?
      ORDER BY ss.position
    `).all(id);

    return setlist;
  }

  getSetlistsByDate(date) {
    const setlists = this.db.prepare(`
      SELECT * FROM setlists WHERE eventDate = ? ORDER BY eventTime
    `).all(date);

    return setlists.map(s => this.getSetlist(s.id));
  }

  searchSetlists(query) {
    const q = `%${query}%`;
    return this.db.prepare(`
      SELECT * FROM setlists
      WHERE name LIKE ? OR description LIKE ? OR location LIKE ? OR eventDate LIKE ?
      ORDER BY eventDate DESC
    `).all(q, q, q, q).map(s => this.getSetlist(s.id));
  }

  createSetlist(data) {
    const id = data.id || `setlist-${Date.now()}`;
    this.db.prepare(`
      INSERT INTO setlists (id, name, description, eventDate, eventTime, location)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.description || '', data.eventDate || '', data.eventTime || '', data.location || '');
    return this.getSetlist(id);
  }

  updateSetlist(id, data) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'id' && key !== 'songs') {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    fields.push("updatedAt = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE setlists SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getSetlist(id);
  }

  deleteSetlist(id) {
    this.db.prepare('DELETE FROM setlists WHERE id = ?').run(id);
    return { ok: true };
  }

  addSongToSetlist(setlistId, songId, position, key, notes) {
    this.db.prepare(`
      INSERT INTO setlist_songs (setlistId, songId, position, key, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(setlistId, songId, position, key || '', notes || '');
    return this.getSetlist(setlistId);
  }

  removeSongFromSetlist(setlistId, songId) {
    this.db.prepare('DELETE FROM setlist_songs WHERE setlistId = ? AND songId = ?').run(setlistId, songId);
    return this.getSetlist(setlistId);
  }

  reorderSetlist(setlistId, songIds) {
    const stmt = this.db.prepare('UPDATE setlist_songs SET position = ? WHERE setlistId = ? AND songId = ?');
    const transaction = this.db.transaction(() => {
      songIds.forEach((songId, idx) => {
        stmt.run(idx, setlistId, songId);
      });
    });
    transaction();
    return this.getSetlist(setlistId);
  }

  // ── Drive Files Cache ─────────────────────────────────────────────

  cacheDriveFiles(files) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO drive_files (id, name, mimeType, size, createdTime, modifiedTime, webViewLink, thumbnailLink, folderName, cachedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const transaction = this.db.transaction(() => {
      for (const file of files) {
        stmt.run(file.id, file.name, file.mimeType, file.size || 0, file.createdTime || '', file.modifiedTime || '', file.webViewLink || '', file.thumbnailLink || '', file.folderName || '');
      }
    });
    transaction();
    return { count: files.length };
  }

  searchDriveFiles(query) {
    const q = `%${query}%`;
    return this.db.prepare(`
      SELECT * FROM drive_files
      WHERE name LIKE ? OR folderName LIKE ?
      ORDER BY modifiedTime DESC
    `).all(q, q);
  }

  getAllDriveFiles() {
    return this.db.prepare('SELECT * FROM drive_files ORDER BY folderName, name').all();
  }

  getDriveFilesByFolder() {
    const files = this.db.prepare('SELECT * FROM drive_files ORDER BY folderName, name').all();
    const grouped = {};
    for (const file of files) {
      const folder = file.folderName || 'Sem pasta';
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(file);
    }
    return grouped;
  }

  clearDriveCache() {
    this.db.prepare('DELETE FROM drive_files').run();
    return { ok: true };
  }

  close() {
    this.db.close();
  }
}

module.exports = { MusicDB };
