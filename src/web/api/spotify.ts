import { Hono } from 'hono';
import type { SpotifyClient } from '../../spotify/client.js';

const app = new Hono();

let spotifyClient: SpotifyClient | undefined;

export function setSpotifyClient(client: SpotifyClient): void {
  spotifyClient = client;
}

// Get spotify status
app.get('/api/spotify/status', (c: any) => {
  if (!spotifyClient) {
    return c.json({ available: false, connected: false });
  }
  return c.json({
    available: true,
    connected: spotifyClient.isAuthenticated(),
    accountName: spotifyClient.getAccountName() || null,
    product: spotifyClient.getProduct() || null,
    deviceId: spotifyClient.getDeviceId() || null,
  });
});

// Get now playing
app.get('/api/spotify/now-playing', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    const text = await spotifyClient.getNowPlayingText();
    return c.json({ text });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Play
app.post('/api/spotify/play', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    await spotifyClient.play();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Pause
app.post('/api/spotify/pause', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    await spotifyClient.pause();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Next track
app.post('/api/spotify/next', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    await spotifyClient.next();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Previous track
app.post('/api/spotify/previous', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    await spotifyClient.previous();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Get devices
app.get('/api/spotify/devices', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    const devices = await spotifyClient.getDevices();
    return c.json({ devices });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Volume
app.post('/api/spotify/volume', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    const body = await c.req.json();
    await spotifyClient.setVolume(body.volume);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Shuffle
app.post('/api/spotify/shuffle', async (c: any) => {
  if (!spotifyClient || !spotifyClient.isAuthenticated()) {
    return c.json({ error: 'Spotify not connected' }, 400);
  }
  try {
    const body = await c.req.json();
    await spotifyClient.setShuffle(body.state ?? true);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
