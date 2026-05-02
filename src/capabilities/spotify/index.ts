import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SpotifyClient } from '../../spotify/client.js';

export function createSpotifySearchTool(spotify: SpotifyClient) {
  return tool({
    description: 'Search Spotify for tracks, artists, albums, or playlists. Returns matching items with Spotify URIs that can be used with play/queue commands.',
    inputSchema: zodSchema(z.object({
      query: z.string().describe('Search query (song name, artist, album, etc.)'),
      type: z.enum(['track', 'artist', 'album', 'playlist']).optional().default('track').describe('Type of item to search for'),
      limit: z.number().optional().default(10).describe('Maximum number of results (1-50)'),
    })),
    execute: async ({ query, type, limit }) => {
      try {
        const data = await spotify.search(query, type, limit);
        if (!data) return 'No results found.';

        const items = data[`${type}s`]?.items || [];
        if (items.length === 0) return `No ${type}s found for "${query}".`;

        const lines = [`**Search results for "${query}"** (${type}s):\n`];
        for (const item of items.slice(0, 10)) {
          if (type === 'track') {
            const artists = item.artists?.map((a: any) => a.name).join(', ');
            lines.push(`• ${artists} — ${item.name} [${item.album?.name || ''}] (uri: ${item.uri})`);
          } else if (type === 'artist') {
            lines.push(`• ${item.name} (${item.followers?.total?.toLocaleString() || '?'} followers) (uri: ${item.uri})`);
          } else if (type === 'album') {
            const artists = item.artists?.map((a: any) => a.name).join(', ');
            lines.push(`• ${artists} — ${item.name} (${item.release_date?.slice(0, 4) || '?'}) (uri: ${item.uri})`);
          } else if (type === 'playlist') {
            lines.push(`• ${item.name} by ${item.owner?.display_name || '?'} (${item.tracks?.total || '?'} tracks) (uri: ${item.uri})`);
          }
        }
        return lines.join('\n');
      } catch (err: any) {
        return `Search failed: ${err.message}`;
      }
    },
  });
}

export function createSpotifyPlayTool(spotify: SpotifyClient) {
  return tool({
    description: 'Play a track, album, or playlist on Spotify. Use URIs from search results. Resumes playback if no URI provided.',
    inputSchema: zodSchema(z.object({
      uri: z.string().optional().describe('Spotify URI to play (e.g. spotify:track:xxx, spotify:album:xxx, spotify:playlist:xxx)'),
      deviceId: z.string().optional().describe('Specific device ID to play on (use list_devices to see available)'),
    })),
    execute: async ({ uri, deviceId }) => {
      try {
        if (uri) {
          const isContext = uri.startsWith('spotify:album:') || uri.startsWith('spotify:playlist:');
          if (isContext) {
            return await spotify.play(undefined, uri, deviceId);
          }
          return await spotify.play([uri], undefined, deviceId);
        }
        return await spotify.play(undefined, undefined, deviceId);
      } catch (err: any) {
        return `Play failed: ${err.message}`;
      }
    },
  });
}

export function createSpotifyPauseTool(spotify: SpotifyClient) {
  return tool({
    description: 'Pause the current Spotify playback.',
    inputSchema: zodSchema(z.object({
      deviceId: z.string().optional().describe('Device ID to pause on'),
    })),
    execute: async ({ deviceId }) => {
      try {
        return await spotify.pause(deviceId);
      } catch (err: any) {
        return `Pause failed: ${err.message}`;
      }
    },
  });
}

export function createSpotifyNextTool(spotify: SpotifyClient) {
  return tool({
    description: 'Skip to the next track on Spotify.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try { return await spotify.next(); } catch (err: any) { return `Next failed: ${err.message}`; }
    },
  });
}

export function createSpotifyPreviousTool(spotify: SpotifyClient) {
  return tool({
    description: 'Skip to the previous track on Spotify.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try { return await spotify.previous(); } catch (err: any) { return `Previous failed: ${err.message}`; }
    },
  });
}

export function createSpotifyNowPlayingTool(spotify: SpotifyClient) {
  return tool({
    description: 'Get information about what is currently playing on Spotify, including track name, artist, progress, and duration.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try {
        const data = await spotify.getCurrentlyPlaying();
        if (!data || !data.item) return 'Nothing is currently playing.';

        const track = data.item;
        const artists = track.artists?.map((a: any) => a.name).join(', ') || 'Unknown';
        const progress = data.progress_ms ? Math.floor(data.progress_ms / 1000) : 0;
        const duration = track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0;
        const pct = duration ? Math.floor((progress / duration) * 100) : 0;
        const shuffle = data.shuffle_state ? 'Shuffle on' : 'Shuffle off';
        const repeat = data.repeat_state || 'off';
        const isPlaying = data.is_playing ? '▶ Playing' : '⏸ Paused';

        const bar = formatBar(progress, duration);
        const lines = [
          `${isPlaying} — **${track.name}** by ${artists}`,
          `${bar} ${formatTime(progress)}/${formatTime(duration)} (${pct}%)`,
          `Album: ${track.album?.name || 'Unknown'} | ${shuffle} | Repeat: ${repeat}`,
        ];
        return lines.join('\n');
      } catch (err: any) {
        return `Now playing check failed: ${err.message}`;
      }
    },
  });
}

export function createSpotifyDevicesTool(spotify: SpotifyClient) {
  return tool({
    description: 'List available Spotify devices the user can play music on.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try {
        const data = await spotify.getDevices();
        if (!data?.devices || data.devices.length === 0) return 'No active Spotify devices found. Open Spotify on a device first.';

        const lines = ['**Available Spotify devices:**\n'];
        for (const device of data.devices) {
          const icon = device.is_active ? '▶' : '○';
          const type = device.type || 'Unknown';
          lines.push(`${icon} **${device.name}** (${type}) — id: \`${device.id}\`${device.is_active ? ' [active]' : ''}`);
        }
        lines.push('\nUse `/spotify device <id>` to switch the active device.');
        return lines.join('\n');
      } catch (err: any) {
        return `Device listing failed: ${err.message}`;
      }
    },
  });
}

export function createSpotifyQueueTool(spotify: SpotifyClient) {
  return tool({
    description: 'Add a track to the Spotify playback queue by URI. Use URIs from search results.',
    inputSchema: zodSchema(z.object({
      uri: z.string().describe('Spotify track URI to add to queue (e.g. spotify:track:xxx)'),
    })),
    execute: async ({ uri }) => {
      try { return await spotify.addToQueue(uri); } catch (err: any) { return `Queue add failed: ${err.message}`; }
    },
  });
}

export function createSpotifyLikeTool(spotify: SpotifyClient) {
  return tool({
    description: 'Like (save) a Spotify track to the user\'s library.',
    inputSchema: zodSchema(z.object({
      trackId: z.string().describe('Spotify track ID (not the full URI, just the ID part)'),
    })),
    execute: async ({ trackId }) => {
      try { return await spotify.likeTrack(trackId); } catch (err: any) { return `Like failed: ${err.message}`; }
    },
  });
}

export function createSpotifyVolumeTool(spotify: SpotifyClient) {
  return tool({
    description: 'Set Spotify playback volume percentage.',
    inputSchema: zodSchema(z.object({
      percent: z.number().min(0).max(100).describe('Volume percentage (0-100)'),
    })),
    execute: async ({ percent }) => {
      try { return await spotify.setVolume(percent); } catch (err: any) { return `Volume change failed: ${err.message}`; }
    },
  });
}

export function createSpotifyShuffleTool(spotify: SpotifyClient) {
  return tool({
    description: 'Toggle Spotify shuffle on or off.',
    inputSchema: zodSchema(z.object({
      state: z.boolean().describe('true to enable shuffle, false to disable'),
    })),
    execute: async ({ state }) => {
      try { return await spotify.setShuffle(state); } catch (err: any) { return `Shuffle toggle failed: ${err.message}`; }
    },
  });
}

export function createSpotifyRepeatTool(spotify: SpotifyClient) {
  return tool({
    description: 'Set Spotify repeat mode.',
    inputSchema: zodSchema(z.object({
      state: z.enum(['off', 'track', 'context']).describe('off = no repeat, track = repeat one, context = repeat all'),
    })),
    execute: async ({ state }) => {
      try { return await spotify.setRepeat(state); } catch (err: any) { return `Repeat change failed: ${err.message}`; }
    },
  });
}

export function createSpotifyTopTracksTool(spotify: SpotifyClient) {
  return tool({
    description: 'Get the user\'s top tracks on Spotify.',
    inputSchema: zodSchema(z.object({
      timeRange: z.enum(['short_term', 'medium_term', 'long_term']).optional().default('medium_term').describe('Time range: short_term (~4 weeks), medium_term (~6 months), long_term (years)'),
      limit: z.number().optional().default(20).describe('Number of tracks (1-50)'),
    })),
    execute: async ({ timeRange, limit }) => {
      try {
        const data = await spotify.getTopTracks(timeRange, limit);
        if (!data?.items?.length) return 'No top tracks found.';
        const lines = ['**Your Top Tracks:**\n'];
        for (let i = 0; i < data.items.length; i++) {
          const t = data.items[i];
          const artists = t.artists?.map((a: any) => a.name).join(', ');
          lines.push(`${i + 1}. ${artists} — ${t.name} (uri: ${t.uri})`);
        }
        return lines.join('\n');
      } catch (err: any) { return `Top tracks failed: ${err.message}`; }
    },
  });
}

export function createSpotifyPlaylistsTool(spotify: SpotifyClient) {
  return tool({
    description: 'Get the user\'s Spotify playlists.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try {
        const data = await spotify.getPlaylists();
        if (!data?.items?.length) return 'No playlists found.';
        const lines = ['**Your Playlists:**\n'];
        for (const p of data.items) {
          lines.push(`• **${p.name}** (${p.tracks?.total || '?'} tracks) — uri: ${p.uri}`);
        }
        return lines.join('\n');
      } catch (err: any) { return `Playlists failed: ${err.message}`; }
    },
  });
}

function formatBar(progress: number, duration: number): string {
  if (!duration) return '';
  const pct = Math.floor((progress / duration) * 20);
  return `[${'█'.repeat(pct)}${'░'.repeat(20 - pct)}]`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}