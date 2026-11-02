import { describe, expect, it } from 'vitest';
import { passedEnv } from './out-of-process.js';

/**
 * A plugin gets only the environment it needs. A desktop plugin (Optimus)
 * also gets the Linux session's addresses: without them it can't reach the
 * screen or the sound server, and its microphone hears nothing.
 */
describe('plugin environment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/a',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
    OPENAI_API_KEY: 'sk-secret',
    AWS_SECRET_ACCESS_KEY: 'nope',
  };

  it('a desktop plugin gets the session, the display and the sound server', () => {
    expect(passedEnv(true, source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/a',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
    });
  });

  it('any other plugin gets only the basics, and no plugin gets secrets from the environment', () => {
    expect(passedEnv(false, source)).toEqual({ PATH: '/usr/bin', HOME: '/home/a' });
  });
});
