import type { SpotifyClient } from './client.js';

export function formatNowPlaying(data: any): string {
  if (!data || !data.item) return 'Nothing playing';
  const track = data.item;
  const artists = track.artists?.map((a: any) => a.name).join(', ') || 'Unknown';
  const name = track.name || 'Unknown';
  const progress = data.progress_ms ? Math.floor(data.progress_ms / 1000) : 0;
  const duration = track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0;
  const pct = duration ? Math.floor((progress / duration) * 20) : 0;
  const bar = `[${'█'.repeat(pct)}${'░'.repeat(20 - pct)}]`;
  const status = data.is_playing ? '▶' : '⏸';
  const shuffle = data.shuffle_state ? '🔀' : '';
  const repeat: Record<string, string> = { off: '', track: '🔂', context: '🔁' };
  const repeatIcon = repeat[data.repeat_state] || '';
  const albumArt = track.album?.images?.[0]?.url;
  let text = `${status} ${name} by ${artists}\n`;
  text += `${bar} ${formatTime(progress)}/${formatTime(duration)}\n`;
  text += `${shuffle}${repeatIcon}`;
  if (albumArt) text += ` | Album: ${track.album?.name}`;
  return text;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const PLAYER_CONTROLS = [
  { value: 'play', label: '▶  Play / Resume' },
  { value: 'pause', label: '⏸  Pause' },
  { value: 'next', label: '⏭  Next Track' },
  { value: 'prev', label: '⏮  Previous Track' },
  { value: 'shuffle', label: '🔀 Toggle Shuffle' },
  { value: 'repeat', label: '🔁 Cycle Repeat' },
  { value: 'now', label: '🎵 Now Playing' },
  { value: 'devices', label: '📱 Devices' },
  { value: 'search', label: '🔍 Search & Play' },
  { value: 'volume_up', label: '🔊 Volume +10%' },
  { value: 'volume_down', label: '🔉 Volume -10%' },
  { value: 'queue', label: '📋 Add to Queue' },
  { value: 'like', label: '❤️  Like Current Track' },
  { value: 'exit', label: '✕  Exit Player' },
];

export async function handlePlayerAction(
  action: string,
  spotify: SpotifyClient,
): Promise<string> {
  switch (action) {
    case 'play':
      return await spotify.play();
    case 'pause':
      return await spotify.pause();
    case 'next':
      return await spotify.next();
    case 'prev':
      return await spotify.previous();
    case 'shuffle': {
      const state = await spotify.getPlaybackState();
      const newState = !(state?.shuffle_state);
      return await spotify.setShuffle(newState);
    }
    case 'repeat': {
      const state = await spotify.getPlaybackState();
      const cycle: Record<string, string> = { off: 'track', track: 'context', context: 'off' };
      const next = cycle[state?.repeat_state || 'off'] || 'off';
      return await spotify.setRepeat(next);
    }
    case 'now':
      return await spotify.getNowPlayingText();
    case 'devices': {
      const data = await spotify.getDevices();
      if (!data?.devices?.length) return 'No active devices. Open Spotify on a device.';
      return data.devices.map((d: any) =>
        `${d.is_active ? '▶' : '○'} ${d.name} (${d.type}) — ${d.id}`
      ).join('\n');
    }
    case 'like': {
      const data = await spotify.getCurrentlyPlaying();
      if (!data?.item?.id) return 'Nothing playing to like.';
      return await spotify.likeTrack(data.item.id);
    }
    case 'volume_up': {
      const state = await spotify.getPlaybackState();
      const current = typeof state?.device?.volume_percent === 'number' ? state.device.volume_percent : 50;
      const next = Math.min(100, current + 10);
      return await spotify.setVolume(next);
    }
    case 'volume_down': {
      const state = await spotify.getPlaybackState();
      const current = typeof state?.device?.volume_percent === 'number' ? state.device.volume_percent : 50;
      const next = Math.max(0, current - 10);
      return await spotify.setVolume(next);
    }
    case 'queue':
      return 'Use `/spotify queue <track name>` to choose what to add.';
    case 'search':
      return 'Use `/spotify search <track name>` to search and play.';
    default:
      return 'Unknown action';
  }
}
