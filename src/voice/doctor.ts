/**
 * Voice doctor — diagnostics for the voice subsystem. Mirrors the shape
 * of `runPlatformDoctor()` (defined in src/index.ts) so users see a
 * familiar layout when troubleshooting.
 *
 * Reports:
 *   • Runtime gates (OS, Bun-compiled, SSH, Termux, canLoadNative)
 *   • Audio backend detection result + probed candidates
 *   • Required binaries (ffmpeg/ffplay, OS-specific recorders)
 *   • TTS / STT provider readiness + which key source they'd use
 *   • Mic permission status (without prompting)
 *   • Current config snapshot (enabled, push-to-talk key, providers)
 *
 * The doctor never mutates state. It does NOT trigger the system mic
 * permission prompt — that's reserved for `/voice grant`. Everything
 * is read-only so users can safely re-run while debugging.
 */
import chalk from 'chalk';
import { runtime } from './runtime.js';
import { detectBackend } from './audio/backends/detector.js';
import { probeAllAudioBinaries } from './audio/system.js';
import { detectMicPermission } from './audio/permissions.js';
import { getCartesiaApiKey, resolveOpenAICredential } from './credentials.js';
import { getTTSChain } from './tts/registry.js';
import { getSTTChain } from './stt/registry.js';
import { loadConfig } from '../utils/config.js';

export async function runVoiceDoctor(): Promise<void> {
  const cfg = loadConfig();
  const voice = cfg.voice;

  console.log('');
  console.log(chalk.bold.cyan('  Mercury Voice Doctor'));
  console.log(chalk.dim('  TTS + STT runtime diagnostics'));
  console.log('');

  // ── Runtime ─────────────────────────────────────────────────────────
  console.log(chalk.bold.white('  Runtime'));
  console.log(`  OS:                 ${chalk.white(runtime.os)} (${process.arch})`);
  console.log(`  Bun-compiled:       ${runtime.isBunCompiled ? chalk.yellow('yes (native addons disabled)') : chalk.green('no')}`);
  console.log(`  SSH session:        ${runtime.isSSH ? chalk.red('yes — voice auto-disabled') : chalk.green('no')}`);
  console.log(`  Termux:             ${runtime.isTermux ? chalk.yellow('yes') : chalk.green('no')}`);
  console.log(`  Native addons:      ${runtime.canLoadNative ? chalk.green('available') : chalk.dim('disabled (Bun-compiled or env-gated)')}`);
  console.log('');

  // ── Config snapshot ─────────────────────────────────────────────────
  console.log(chalk.bold.white('  Configuration'));
  console.log(`  voice.enabled:      ${voice?.enabled ? chalk.green('true') : chalk.yellow('false (run `mercury doctor` to enable)')}`);
  console.log(`  push-to-talk key:   ${chalk.white(voice?.pushToTalkKey ?? '(unset)')}`);
  console.log(`  TTS provider:       ${chalk.white(voice?.tts?.provider ?? 'cartesia')}  → fallback ${chalk.dim(voice?.tts?.fallback ?? 'none')}`);
  console.log(`  STT provider:       ${chalk.white(voice?.stt?.provider ?? 'cartesia')}  → fallback ${chalk.dim(voice?.stt?.fallback ?? 'none')}`);
  console.log(`  live captions:      ${voice?.stt?.liveCaptions ? chalk.green('on') : chalk.dim('off')}`);
  console.log(`  auto-submit STT:    ${voice?.stt?.autoSubmit ? chalk.green('on') : chalk.dim('off')}`);
  console.log('');

  // ── Backend detection ───────────────────────────────────────────────
  console.log(chalk.bold.white('  Audio Backend'));
  const detection = await detectBackend();
  if (detection.backend) {
    console.log(`  Selected:           ${chalk.green(detection.backend.name)}  (latency ~${detection.backend.capabilities.latencyMs}ms)`);
  } else {
    console.log(`  Selected:           ${chalk.red('none')}`);
    if (detection.reason) console.log(`  Reason:             ${chalk.yellow(detection.reason)}`);
  }
  if (detection.probed.length > 0) {
    console.log(chalk.dim('  Probed candidates:'));
    for (const p of detection.probed) {
      const icon = p.available ? chalk.green('✓') : chalk.dim('·');
      const tail = p.reason ? chalk.dim(`   (${p.reason})`) : '';
      console.log(`    ${icon} ${p.name}${tail}`);
    }
  }
  console.log('');

  // ── Binaries ────────────────────────────────────────────────────────
  console.log(chalk.bold.white('  System Binaries'));
  const binaries = probeAllAudioBinaries();
  for (const b of binaries) {
    if (b.path) {
      const ver = b.version ? chalk.dim(` v${b.version}`) : '';
      console.log(`  ${chalk.green('✓')} ${b.name.padEnd(28)} ${chalk.white(b.path)}${ver}`);
    } else {
      const hint = b.installHint ? chalk.dim(`   ${b.installHint}`) : '';
      console.log(`  ${chalk.dim('·')} ${b.name.padEnd(28)} ${chalk.yellow('not found')}${hint}`);
    }
  }
  console.log('');

  // ── Credentials ────────────────────────────────────────────────────
  console.log(chalk.bold.white('  Credentials'));
  const cartesiaKey = getCartesiaApiKey();
  if (cartesiaKey) {
    const src = process.env.CARTESIA_API_KEY?.trim() ? 'env (CARTESIA_API_KEY)' : 'config (voice.cartesiaApiKey)';
    console.log(`  Cartesia:           ${chalk.green('✓ key present')} ${chalk.dim(`(${src})`)}`);
  } else {
    console.log(`  Cartesia:           ${chalk.yellow('not configured')} ${chalk.dim('— set via `mercury doctor` or export CARTESIA_API_KEY')}`);
  }
  const openaiCred = await resolveOpenAICredential();
  if (openaiCred) {
    console.log(`  OpenAI (fallback):  ${chalk.green('✓')} ${chalk.dim(`(${openaiCred.kind})`)}`);
  } else {
    console.log(`  OpenAI (fallback):  ${chalk.dim('not available')}`);
  }
  console.log('');

  // ── Provider readiness ─────────────────────────────────────────────
  console.log(chalk.bold.white('  Provider Readiness'));
  const ttsChain = await getTTSChain();
  for (const p of ttsChain) {
    const ok = await safeIsAvailable(p);
    console.log(`  TTS  ${p.name.padEnd(10)}    ${ok ? chalk.green('ready') : chalk.dim('unavailable')}  ${chalk.dim(`(streaming=${p.capabilities.streaming}, ${p.capabilities.nativeSampleRate}Hz)`)}`);
  }
  const sttChain = await getSTTChain();
  for (const p of sttChain) {
    const ok = await safeIsAvailable(p);
    console.log(`  STT  ${p.name.padEnd(10)}    ${ok ? chalk.green('ready') : chalk.dim('unavailable')}  ${chalk.dim(`(streaming=${p.capabilities.streaming})`)}`);
  }
  console.log('');

  // ── Microphone permission ──────────────────────────────────────────
  console.log(chalk.bold.white('  Microphone'));
  try {
    const perm = await detectMicPermission();
    const tone =
      perm.status === 'authorized' ? chalk.green('authorized') :
      perm.status === 'denied'  ? chalk.red('denied — open System Settings to re-grant') :
      perm.status === 'not-determined' ? chalk.yellow('not yet prompted — Mercury will ask on first /voice listen') :
      chalk.dim(perm.status);
    console.log(`  Permission:         ${tone}`);
    if (perm.status !== 'authorized') console.log(`  Hint:               ${chalk.dim(perm.hint())}`);
  } catch (err: any) {
    console.log(`  Permission:         ${chalk.dim(`probe failed: ${err?.message ?? err}`)}`);
  }
  console.log('');

  // ── Summary ─────────────────────────────────────────────────────────
  const ready =
    !!detection.backend &&
    (!!cartesiaKey || !!openaiCred) &&
    !!voice?.enabled;
  if (ready) {
    console.log(chalk.green('  ✓ Voice is ready. Try /voice in the TUI, or POST /api/voice/speak from the web.'));
  } else {
    const blockers: string[] = [];
    if (!voice?.enabled) blockers.push('voice.enabled is false');
    if (!detection.backend) blockers.push('no audio backend');
    if (!cartesiaKey && !openaiCred) blockers.push('no TTS/STT credentials');
    console.log(chalk.yellow(`  ⚠ Voice not ready — blockers: ${blockers.join(', ')}`));
    console.log(chalk.dim('  Re-run `mercury doctor` to walk the voice setup wizard.'));
  }
  console.log('');
}

async function safeIsAvailable(p: { isAvailable: () => Promise<boolean> }): Promise<boolean> {
  try { return await p.isAvailable(); } catch { return false; }
}
