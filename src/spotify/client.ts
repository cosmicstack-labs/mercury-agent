import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getMercuryHome, saveConfig } from '../utils/config.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const REQUIRED_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-top-read',
  'user-read-recently-played',
];

export class SpotifyClient {
  private config: MercuryConfig;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private deviceId: string;
  private isPremium: boolean | null = null;

  constructor(config: MercuryConfig) {
    this.config = config;
    this.accessToken = config.spotify.accessToken;
    this.refreshToken = config.spotify.refreshToken;
    this.expiresAt = config.spotify.expiresAt ? new Date(config.spotify.expiresAt).getTime() : 0;
    this.deviceId = config.spotify.deviceId;
  }

  isAuthenticated(): boolean {
    return !!(this.accessToken || this.refreshToken);
  }

  async authenticate(): Promise<string> {
    const clientId = this.config.spotify.clientId;
    const constClientSecret = this.config.spotify.clientSecret;
    const redirectUri = this.config.spotify.redirectUri;

    if (!clientId || !constClientSecret) {
      throw new Error('Spotify Client ID and Secret must be configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
    }

    const scope = REQUIRED_SCOPES.join(' ');
    const state = Math.random().toString(36).substring(2, 15);
    const authUrl = `${SPOTIFY_AUTH_URL}?response_type=code&client_id=${clientId}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    return new Promise((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://localhost`);

        if (url.pathname === '/' || url.pathname === '/login') {
          res.writeHead(302, { Location: authUrl });
          res.end();
          return;
        }

        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          const returnedState = url.searchParams.get('state');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>Mercury — Spotify Auth</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#eee;text-align:center;}h1{color:#e74c3c;}p{color:#aaa;}</style></head><body><div><h1>Authorization Failed</h1><p>Spotify authorization was denied or cancelled.</p><p>You can close this tab.</p></div></body></html>`);
            server.close();
            reject(new Error(`Spotify auth error: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>Mercury — Spotify Auth</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#eee;text-align:center;}h1{color:#e74c3c;}p{color:#aaa;}</style></head><body><div><h1>Security Error</h1><p>State mismatch. Please try again.</p></div></body></html>`);
            server.close();
            reject(new Error('Spotify auth state mismatch'));
            return;
          }

          try {
            const tokenResponse: any = await this.exchangeCode(code!, redirectUri);
            this.accessToken = tokenResponse.access_token;
            this.refreshToken = tokenResponse.refresh_token;
            this.expiresAt = Date.now() + tokenResponse.expires_in * 1000;

            this.config.spotify.accessToken = this.accessToken;
            this.config.spotify.refreshToken = this.refreshToken;
            this.config.spotify.expiresAt = new Date(this.expiresAt).toISOString();
            this.config.spotify.scopes = REQUIRED_SCOPES;
            this.config.spotify.enabled = true;
            saveConfig(this.config);

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>Mercury — Spotify Connected</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#eee;text-align:center;}h1{color:#1db954;font-size:2em;}p{color:#aaa;max-width:400px;margin:0 auto;}.logo{font-size:3em;margin-bottom:0.3em;}</style></head><body><div><div class="logo">&#x266B;</div><h1>Mercury x Spotify</h1><p>Your Spotify account is now connected!</p><p>You can close this tab and return to Mercury.</p><p style="margin-top:2em;color:#666;">Try saying: "play some chill music"</p></div></body></html>`);
            server.close();
            logger.info('Spotify authentication successful');

            this.saveAccountInfo().catch(() => {});
            this.checkPremium().then((premium) => {
              if (!premium) {
                logger.warn('Spotify account is not Premium — playback control will be unavailable');
              }
            }).catch(() => {});

            resolve(this.accessToken);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>Mercury — Spotify Auth</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#eee;text-align:center;}h1{color:#e74c3c;}p{color:#aaa;}</style></head><body><div><h1>Token Exchange Failed</h1><p>Could not exchange authorization code for tokens.</p><p>Please run /spotify auth again.</p></div></body></html>`);
            server.close();
            reject(err);
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      const port = new URL(redirectUri).port || '8888';
      server.listen(parseInt(port, 10), () => {
        logger.info({ port }, 'Spotify OAuth server listening');
        const callbackUrl = `http://127.0.0.1:${port}/login`;
        console.log(`\n  ${'─'.repeat(50)}`);
        console.log(`  Spotify Authorization`);
        console.log(`  ${'─'.repeat(50)}`);
        console.log(`  Opening browser for Spotify login...`);
        console.log(`  If browser doesn't open, visit:\n  ${callbackUrl}\n`);
        console.log(`  ${'─'.repeat(50)}\n`);
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execAsync(`${cmd} "${callbackUrl}"`).catch(() => {
          console.log(`  Could not auto-open browser. Visit:\n  ${callbackUrl}\n`);
        });
      });

      server.setTimeout(300000, () => {
        server.close();
        reject(new Error('Spotify auth timed out after 5 minutes'));
      });
    });
  }

  getAuthUrl(): string {
    const clientId = this.config.spotify.clientId;
    const redirectUri = this.config.spotify.redirectUri;
    const scope = REQUIRED_SCOPES.join(' ');
    const state = Math.random().toString(36).substring(2, 15);
    return `${SPOTIFY_AUTH_URL}?response_type=code&client_id=${clientId}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  }

  async authenticateWithCode(code: string): Promise<string> {
    const redirectUri = this.config.spotify.redirectUri;
    const tokenResponse: any = await this.exchangeCode(code, redirectUri);
    this.accessToken = tokenResponse.access_token;
    this.refreshToken = tokenResponse.refresh_token;
    this.expiresAt = Date.now() + tokenResponse.expires_in * 1000;

    this.config.spotify.accessToken = this.accessToken;
    this.config.spotify.refreshToken = this.refreshToken;
    this.config.spotify.expiresAt = new Date(this.expiresAt).toISOString();
    this.config.spotify.scopes = REQUIRED_SCOPES;
    this.config.spotify.enabled = true;
    saveConfig(this.config);

    logger.info('Spotify authentication successful (manual code)');

    this.saveAccountInfo().catch(() => {});
    this.checkPremium().then((premium) => {
      if (!premium) {
        logger.warn('Spotify account is not Premium — playback control will be unavailable');
      }
    }).catch(() => {});

    return this.accessToken;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<any> {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.config.spotify.clientId}:${this.config.spotify.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Spotify token exchange failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) {
      return this.accessToken;
    }

    if (!this.refreshToken) {
      throw new Error('Spotify not authenticated. Run /spotify auth to connect.');
    }

    logger.info('Refreshing Spotify access token');
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.config.spotify.clientId}:${this.config.spotify.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.accessToken = '';
        this.refreshToken = '';
        this.config.spotify.accessToken = '';
        this.config.spotify.refreshToken = '';
        saveConfig(this.config);
        throw new Error('Spotify refresh token expired. Run /spotify auth again.');
      }
      const text = await response.text();
      throw new Error(`Spotify token refresh failed: ${response.status} ${text}`);
    }

    const data: any = await response.json();
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }

    this.config.spotify.accessToken = this.accessToken;
    this.config.spotify.refreshToken = this.refreshToken;
    this.config.spotify.expiresAt = new Date(this.expiresAt).toISOString();
    saveConfig(this.config);

    return this.accessToken;
  }

  private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
    const token = await this.ensureToken();
    const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 204) return null;
    if (response.status === 401) {
      this.accessToken = '';
      throw new Error('Spotify token expired. Retrying...');
    }
    if (response.status === 403) {
      const isPlaybackEndpoint = endpoint.includes('/me/player') && !endpoint.includes('/me/player/devices') && !endpoint.includes('/me/player/currently-playing') && !endpoint.includes('/me/player/queue');
      if (isPlaybackEndpoint) {
        throw new Error('Spotify Premium is required for playback control (play, pause, skip, volume, etc.). Read-only features like search, playlists, and liked songs work on free accounts.');
      }
      const text = await response.text();
      throw new Error(`Spotify API error 403: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Spotify API error ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  async search(query: string, type: string = 'track', limit: number = 20): Promise<any> {
    return this.apiRequest(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
  }

  async getDevices(): Promise<any> {
    return this.apiRequest('/me/player/devices');
  }

  async play(uris?: string[], contextUri?: string, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/play?device_id=${id}` : '/me/player/play';
    const body: any = {};
    if (contextUri) body.context_uri = contextUri;
    if (uris) body.uris = uris;
    if (!contextUri && !uris) {
      // Resume playback
    }

    await this.apiRequest(endpoint, { method: 'PUT', body: JSON.stringify(body) });
    return contextUri
      ? `Playing context: ${contextUri}${id ? ` on device ${id}` : ''}`
      : uris
        ? `Playing ${uris.length} track(s)${id ? ` on device ${id}` : ''}`
        : 'Playback resumed';
  }

  async pause(deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/pause?device_id=${id}` : '/me/player/pause';
    await this.apiRequest(endpoint, { method: 'PUT' });
    return 'Playback paused';
  }

  async next(deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/next?device_id=${id}` : '/me/player/next';
    await this.apiRequest(endpoint, { method: 'POST' });
    return 'Skipped to next track';
  }

  async previous(deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/previous?device_id=${id}` : '/me/player/previous';
    await this.apiRequest(endpoint, { method: 'POST' });
    return 'Skipped to previous track';
  }

  async seek(positionMs: number, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/seek?position_ms=${positionMs}&device_id=${id}` : `/me/player/seek?position_ms=${positionMs}`;
    await this.apiRequest(endpoint, { method: 'PUT' });
    return `Seeked to ${Math.floor(positionMs / 1000)}s`;
  }

  async setRepeat(state: string, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/repeat?state=${state}&device_id=${id}` : `/me/player/repeat?state=${state}`;
    await this.apiRequest(endpoint, { method: 'PUT' });
    const labels: Record<string, string> = { off: 'off', track: 'repeat one', context: 'repeat all' };
    return `Repeat mode: ${labels[state] || state}`;
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/shuffle?state=${state}&device_id=${id}` : `/me/player/shuffle?state=${state}`;
    await this.apiRequest(endpoint, { method: 'PUT' });
    return `Shuffle ${state ? 'on' : 'off'}`;
  }

  async setVolume(percent: number, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/volume?volume_percent=${percent}&device_id=${id}` : `/me/player/volume?volume_percent=${percent}`;
    await this.apiRequest(endpoint, { method: 'PUT' });
    return `Volume set to ${percent}%`;
  }

  async addToQueue(uri: string, deviceId?: string): Promise<string> {
    const id = deviceId || this.deviceId;
    const endpoint = id ? `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${id}` : `/me/player/queue?uri=${encodeURIComponent(uri)}`;
    await this.apiRequest(endpoint, { method: 'POST' });
    return 'Added to queue';
  }

  async getCurrentlyPlaying(): Promise<any> {
    return this.apiRequest('/me/player/currently-playing');
  }

  async getPlaybackState(): Promise<any> {
    return this.apiRequest('/me/player');
  }

  async getQueue(): Promise<any> {
    return this.apiRequest('/me/player/queue');
  }

  async getLikedTracks(limit: number = 50, offset: number = 0): Promise<any> {
    return this.apiRequest(`/me/tracks?limit=${limit}&offset=${offset}`);
  }

  async likeTrack(ids: string): Promise<string> {
    await this.apiRequest('/me/tracks', { method: 'PUT', body: JSON.stringify({ ids: [ids] }) });
    return 'Track saved to library';
  }

  async unlikeTrack(ids: string): Promise<string> {
    await this.apiRequest(`/me/tracks?ids=${ids}`, { method: 'DELETE' });
    return 'Track removed from library';
  }

  async getTopTracks(timeRange: string = 'medium_term', limit: number = 20): Promise<any> {
    return this.apiRequest(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
  }

  async getTopArtists(timeRange: string = 'medium_term', limit: number = 20): Promise<any> {
    return this.apiRequest(`/me/top/artists?time_range=${timeRange}&limit=${limit}`);
  }

  async getPlaylists(limit: number = 50): Promise<any> {
    return this.apiRequest(`/me/playlists?limit=${limit}`);
  }

  async getPlaylist(playlistId: string): Promise<any> {
    return this.apiRequest(`/playlists/${playlistId}`);
  }

  async createPlaylist(name: string, description: string = '', isPublic: boolean = false): Promise<any> {
    const userId = await this.getMe();
    return this.apiRequest(`/users/${userId.id}/playlists`, {
      method: 'POST',
      body: JSON.stringify({ name, description, public: isPublic }),
    });
  }

  async addTracksToPlaylist(playlistId: string, uris: string[]): Promise<any> {
    return this.apiRequest(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris }),
    });
  }

  async getMe(): Promise<any> {
    return this.apiRequest('/me');
  }

  async checkPremium(): Promise<boolean | null> {
    if (this.isPremium !== null) return this.isPremium;
    try {
      const me = await this.getMe();
      this.isPremium = me.product === 'premium';
      this.config.spotify.product = me.product || '';
      saveConfig(this.config);
      return this.isPremium;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to check Spotify premium status');
      return null;
    }
  }

  getPremiumStatus(): boolean | null {
    return this.isPremium;
  }

  setDevice(deviceId: string): void {
    this.deviceId = deviceId;
    this.config.spotify.deviceId = deviceId;
    saveConfig(this.config);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  async saveAccountInfo(): Promise<void> {
    try {
      const me = await this.getMe();
      this.config.spotify.accountName = me.display_name || '';
      this.config.spotify.accountId = me.id || '';
      this.config.spotify.product = me.product || '';
      this.isPremium = me.product === 'premium';
      saveConfig(this.config);
    } catch {
      logger.warn('Could not fetch Spotify account info');
    }
  }

  getAccountName(): string {
    return this.config.spotify.accountName;
  }

  getAccountId(): string {
    return this.config.spotify.accountId;
  }

  getProduct(): string {
    return this.config.spotify.product;
  }

  logout(): void {
    this.accessToken = '';
    this.refreshToken = '';
    this.expiresAt = 0;
    this.isPremium = null;
    this.deviceId = '';
    this.config.spotify.accessToken = '';
    this.config.spotify.refreshToken = '';
    this.config.spotify.expiresAt = '';
    this.config.spotify.scopes = [];
    this.config.spotify.deviceId = '';
    this.config.spotify.accountName = '';
    this.config.spotify.accountId = '';
    this.config.spotify.product = '';
    this.config.spotify.enabled = false;
    saveConfig(this.config);
    logger.info('Spotify logged out');
  }

  async getNowPlayingText(): Promise<string> {
    try {
      const data = await this.getCurrentlyPlaying();
      if (!data || !data.item) return 'Nothing playing';

      const track = data.item;
      const artists = track.artists?.map((a: any) => a.name).join(', ') || 'Unknown';
      const name = track.name || 'Unknown';
      const progress = data.progress_ms ? Math.floor(data.progress_ms / 1000) : 0;
      const duration = track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0;
      const bar = this.formatProgressBar(progress, duration);

      return `${artists} — ${name} ${bar}`;
    } catch {
      return 'Could not fetch playback state';
    }
  }

  private formatProgressBar(progress: number, duration: number): string {
    if (!duration) return '';
    const pct = Math.floor((progress / duration) * 20);
    const filled = '█'.repeat(pct);
    const empty = '░'.repeat(20 - pct);
    return `[${filled}${empty}] ${this.formatTime(progress)}/${this.formatTime(duration)}`;
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}