const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'data', 'google-credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'data', 'google-token.json');

class GoogleDrive {
  constructor(options = {}) {
    this.credentialsPath = options.credentialsPath || CREDENTIALS_PATH;
    this.tokenPath = options.tokenPath || TOKEN_PATH;
    this.scopes = ['https://www.googleapis.com/auth/drive.readonly'];
    this.auth = null;
    this.drive = null;
    this.onLog = options.onLog || console.log;
  }

  // ── Autenticação ──────────────────────────────────────────────────

  isConfigured() {
    return fs.existsSync(this.credentialsPath);
  }

  isAuthenticated() {
    return fs.existsSync(this.tokenPath);
  }

  getAuthUrl() {
    const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    const { client_id, redirect_uris } = credentials.installed || credentials.web;
    const oauth2Client = new google.auth.OAuth2(client_id, '', redirect_uris[0]);

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: this.scopes,
      prompt: 'consent'
    });
  }

  async authenticate(authCode) {
    const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const { tokens } = await oauth2Client.getToken(authCode);
    oauth2Client.setCredentials(tokens);

    fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));

    this.auth = oauth2Client;
    this.drive = google.drive({ version: 'v3', auth: this.auth });

    this.onLog('[Drive] Autenticado com sucesso');
    return true;
  }

  async loadSavedAuth() {
    if (!this.isAuthenticated()) return false;

    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
      const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

      const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      oauth2Client.setCredentials(token);

      // Verificar se token expirou e renovar
      if (token.expiry_date && token.expiry_date < Date.now()) {
        const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newTokens);
        fs.writeFileSync(this.tokenPath, JSON.stringify(newTokens, null, 2));
        this.onLog('[Drive] Token renovado');
      }

      this.auth = oauth2Client;
      this.drive = google.drive({ version: 'v3', auth: this.auth });
      return true;
    } catch (e) {
      this.onLog(`[Drive] Erro ao carregar autenticação: ${e.message}`);
      return false;
    }
  }

  // ── Buscar arquivos ───────────────────────────────────────────────

  async searchFiles(query, maxResults = 50) {
    if (!this.drive) {
      await this.loadSavedAuth();
      if (!this.drive) throw new Error('Google Drive não configurado');
    }

    this.onLog(`[Drive] Buscando: "${query}"`);

    const response = await this.drive.files.list({
      q: query,
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, thumbnailLink, parents)',
      orderBy: 'name'
    });

    const files = response.data.files || [];
    this.onLog(`[Drive] ${files.length} arquivos encontrados`);

    // Buscar nomes das pastas pai
    const parentIds = [...new Set(files.flatMap(f => f.parents || []))];
    const folderNames = {};

    for (const parentId of parentIds) {
      try {
        const folder = await this.drive.files.get({
          fileId: parentId,
          fields: 'name'
        });
        folderNames[parentId] = folder.data.name;
      } catch {
        folderNames[parentId] = 'Raiz';
      }
    }

    return files.map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: parseInt(f.size || 0),
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      thumbnailLink: f.thumbnailLink,
      folderName: folderNames[f.parents?.[0]] || 'Raiz'
    }));
  }

  async searchAudioFiles(maxResults = 100) {
    const query = "mimeType contains 'audio/' or name contains '.mp3' or name contains '.wav' or name contains '.m4a' or name contains '.flac' or name contains '.ogg'";
    return this.searchFiles(query, maxResults);
  }

  async searchFolders(maxResults = 50) {
    const query = "mimeType = 'application/vnd.google-apps.folder'";
    return this.searchFiles(query, maxResults);
  }

  async searchInFolder(folderId, query = '', maxResults = 100) {
    let q = `'${folderId}' in parents`;
    if (query) {
      q += ` and name contains '${query}'`;
    }
    return this.searchFiles(q, maxResults);
  }

  async getFolderContents(folderId) {
    return this.searchInFolder(folderId);
  }

  // ── Listar pastas de música ───────────────────────────────────────

  async listMusicFolders() {
    const query = "mimeType = 'application/vnd.google-apps.folder' and (name contains 'música' or name contains 'music' or name contains 'louvor' or name contains 'worship' or name contains 'backing' or name contains 'cifra')";
    return this.searchFiles(query, 50);
  }

  // ── Sincronizar com banco local ───────────────────────────────────

  async syncToDatabase(db) {
    this.onLog('[Drive] Sincronizando com banco de dados...');

    const files = await this.searchAudioFiles(500);
    const result = db.cacheDriveFiles(files);

    this.onLog(`[Drive] ${result.count} arquivos sincronizados`);
    return result;
  }
}

module.exports = { GoogleDrive };
