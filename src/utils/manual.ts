import chalk from 'chalk';

export function getManual(): string {
  const sections: string[] = [];

  sections.push('');
  sections.push(chalk.bold.cyan('  MERCURY — Capabilities & Commands'));
  sections.push(chalk.dim('  ─────────────────────────────────────────'));
  sections.push('');

  sections.push(chalk.bold.white('  Built-in Tools'));
  sections.push(chalk.dim('  Tools Mercury can use during conversations.'));
  sections.push('');

  const tools = [
    ['read_file', 'Read file contents', 'path (required)'],
    ['write_file', 'Write to an existing file', 'path, content'],
    ['create_file', 'Create a new file (+ dirs)', 'path, content'],
    ['edit_file', 'Replace specific text in a file', 'path, old_string, new_string'],
    ['list_dir', 'List directory contents', 'path'],
    ['delete_file', 'Delete a file', 'path'],
    ['send_message', 'Send a message to approved Telegram users', 'content'],
    ['run_command', 'Execute a shell command', 'command'],
    ['approve_command', 'Permanently approve a command type', 'command (e.g. "curl")'],
    ['fetch_url', 'Fetch a URL and return content', 'url, format? (text/markdown)'],
    ['git_status', 'Show working tree status', 'path?'],
    ['git_diff', 'Show file changes', 'path?, staged?'],
    ['git_log', 'Show commit history', 'count?, path?'],
    ['git_add', 'Stage files for commit', 'paths (array)'],
    ['git_commit', 'Create a commit', 'message'],
    ['git_push', 'Push to remote (needs approval)', 'remote?, branch?'],
    ['install_skill', 'Install a skill from content or URL', 'content? or url?'],
    ['list_skills', 'List installed skills', '—'],
    ['use_skill', 'Invoke a skill by name', 'name'],
    ['schedule_task', 'Schedule a recurring or delayed task', 'cron? or delay_seconds, description, prompt? or skill_name?'],
    ['list_scheduled_tasks', 'List all scheduled tasks', '—'],
    ['cancel_scheduled_task', 'Cancel a scheduled task', 'id'],
    ['budget_status', 'Check token budget', '—'],
    ['delegate_task', 'Delegate a task to a sub-agent', 'task, workingDirectory?, priority?, allowedTools?'],
    ['list_agents', 'List active sub-agents', '—'],
    ['stop_agent', 'Stop a sub-agent (or all)', 'agentId ("a1" or "all")'],
    ['ask_user', 'Ask user a question with choices', 'question, choices[]'],
    ['spotify_search', 'Search Spotify for tracks/artists/albums/playlists', 'query, type?, limit?'],
    ['spotify_play', 'Play a track/album/playlist on Spotify', 'uri?, deviceId?'],
    ['spotify_pause', 'Pause Spotify playback', 'deviceId?'],
    ['spotify_next', 'Skip to next track', '—'],
    ['spotify_previous', 'Skip to previous track', '—'],
    ['spotify_now_playing', 'Show currently playing track info', '—'],
    ['spotify_devices', 'List available Spotify devices', '—'],
    ['spotify_queue', 'Add track to playback queue', 'uri'],
    ['spotify_like', 'Like (save) a track to library', 'trackId'],
    ['spotify_volume', 'Set playback volume', 'percent (0-100)'],
    ['spotify_shuffle', 'Toggle shuffle on/off', 'state (boolean)'],
    ['spotify_repeat', 'Set repeat mode', 'state (off/track/context)'],
    ['spotify_top_tracks', 'Get user\'s top tracks', 'timeRange?, limit?'],
    ['spotify_playlists', 'Get user\'s playlists', '—'],
  ];

  for (const [name, desc, params] of tools) {
    sections.push(`  ${chalk.cyan(name.padEnd(24))} ${desc}`);
    sections.push(`  ${' '.repeat(24)} ${chalk.dim(params)}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  CLI Commands'));
  sections.push(chalk.dim('  Run these from your terminal (no API calls consumed).'));
  sections.push('');

  const commands = [
    ['mercury up', 'Start persistently (install service + daemon)'],
    ['mercury', 'Start the agent (same as mercury start)'],
    ['mercury start', 'Start the agent in foreground'],
    ['mercury start -d', 'Start in background (daemon mode)'],
    ['mercury restart', 'Restart a background process'],
    ['mercury stop', 'Stop a background process'],
    ['mercury logs', 'Show recent daemon logs'],
    ['mercury doctor', 'Reconfigure settings (Enter keeps current)'],
    ['mercury doctor --platform', 'Show cross-platform terminal/daemon compatibility diagnostics'],
    ['mercury setup', 'Re-run the setup wizard'],
    ['mercury status', 'Show config and daemon status'],
    ['mercury telegram list', 'Show Telegram admins, members, and pending requests'],
    ['mercury telegram approve <code|id>', 'Approve the first Telegram pairing code or a later Telegram request'],
    ['mercury telegram reject <id>', 'Reject a pending Telegram request'],
    ['mercury telegram remove <id>', 'Remove an approved Telegram user'],
    ['mercury telegram promote <id>', 'Promote a Telegram member to admin'],
    ['mercury telegram demote <id>', 'Demote a Telegram admin to member'],
    ['mercury telegram unpair', 'Reset all Telegram access'],
    ['mercury help', 'Show this manual'],
    ['mercury service install', 'Install as system service (auto-start)'],
    ['mercury service uninstall', 'Uninstall system service'],
    ['mercury service status', 'Show system service status'],
    ['mercury --verbose', 'Start with debug logging on stderr'],
  ];

  for (const [cmd, desc] of commands) {
    sections.push(`  ${chalk.white(cmd.padEnd(26))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  In-Chat Commands'));
  sections.push(chalk.dim('  Type these during a conversation (no API calls).'));
  sections.push('');

  const chat = [
    ['/start', 'Start Telegram pairing or request Telegram access'],
    ['/pair', 'Start Telegram pairing or request Telegram access'],
    ['/', 'Open the CLI command picker with arrow-key navigation'],
    ['/menu', 'Open the CLI command picker with arrow-key navigation'],
    ['/help', 'Show this manual'],
    ['/status', 'Show config and budget info'],
    ['/progress', 'Show live status for the current long task'],
    ['/telegram', 'CLI chat only: open the Telegram management menu'],
    ['/telegram pending', 'CLI chat only: list pending Telegram requests'],
    ['/telegram users', 'CLI chat only: list approved Telegram users'],
    ['/telegram approve <code|id>', 'CLI chat only: approve the first pairing code or a later request'],
    ['/telegram reject <id>', 'CLI chat only: reject a pending Telegram request'],
    ['/telegram remove <id>', 'CLI chat only: remove an approved Telegram user'],
    ['/telegram promote <id>', 'CLI chat only: promote a Telegram member to admin'],
    ['/telegram demote <id>', 'CLI chat only: demote a Telegram admin to member'],
    ['/telegram reset', 'CLI chat only: reset all Telegram access'],
    ['/tools', 'List currently loaded tools'],
    ['/skills', 'List installed skills'],
    ['/permissions', 'Change permission mode (Ask Me / Allow All)'],
    ['/view', 'Toggle progress view (balanced/detailed)'],
    ['/view balanced', 'Set compact progress view'],
    ['/view detailed', 'Set full progress view'],
    ['/tasks', 'List scheduled tasks'],
    ['/memory', 'View and manage second brain memory'],
    ['/stream', 'Toggle text streaming on/off (Telegram)'],
    ['/stream on', 'Enable streaming (live text updates)'],
    ['/stream off', 'Disable streaming (single message)'],
    ['/agents', 'List all sub-agents and their status'],
    ['/agents stop <id|all>', 'Stop a sub-agent or all sub-agents'],
    ['/agents pause <id>', 'Pause a running sub-agent'],
    ['/agents resume <id>', 'Resume a paused sub-agent'],
    ['/agents config', 'Show sub-agent resource allocation'],
    ['/agents set max <n>', 'Set max concurrent sub-agents'],
    ['/code', 'Show programming mode status'],
    ['/code plan', 'Switch to plan mode (analyze, present options, no coding)'],
    ['/code execute', 'Switch to execute mode (implement plan step by step)'],
    ['/code build', 'Alias of execute mode for build-focused coding'],
    ['/code workspace', 'Open current directory in workspace IDE mode'],
    ['/code agent <task>', 'Delegate a coding task to a sub-agent in background'],
    ['/code off', 'Exit programming mode'],
    ['/code toggle', 'Cycle through: off → plan → execute → off'],
    ['/ws exit', 'Exit workspace IDE mode back to general chat'],
    ['/ws open <path>', 'Open a workspace directory in IDE mode'],
    ['/ws refresh', 'Refresh file tree + git status panel'],
    ['/ws stage <file|all>', 'Stage a file or all changes'],
    ['/ws commit <message>', 'Commit staged changes (Mercury co-authored)'],
    ['/ws undo <file>', 'Revert file changes with git checkout -- <file>'],
    ['/halt', 'Emergency: stop all agents + clear queue'],
    ['/stop', 'Stop all agents + clear queue + release locks + clear task board'],
    ['/reset', 'Full reset: stop all + clear context (requires confirmation)'],
    ['/spotify', 'Show Spotify connection status'],
    ['/spotify auth', 'Connect Spotify (browser or manual code flow)'],
    ['/spotify code <code>', 'Complete auth with a pasted authorization code (for SSH/Telegram)'],
    ['/spotify player', 'Interactive music player (CLI only: arrow-key controls, search, queue)'],
    ['/spotify devices', 'List available Spotify devices'],
    ['/spotify device <id>', 'Set active Spotify device'],
    ['/spotify now', 'Show what is currently playing'],
    ['/spotify logout', 'Disconnect Spotify and clear saved tokens'],
    ['/unpair', 'Reset all Telegram access for this Mercury instance (admins only)'],
  ];

  for (const [cmd, desc] of chat) {
    sections.push(`  ${chalk.white(cmd.padEnd(16))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Permissions'));
  sections.push('');

  const perms = [
    'Commands are blocked (never run), auto-approved, or need approval.',
    'Use interactive approval prompts: ↑/↓ + Enter (or Y/N/A shortcuts).',
    'Choose "Always" when prompted to permanently approve a command type.',
    'Edit ~/.mercury/permissions.yaml to customize manually.',
    'File access is scoped — new paths need approval (Yes/No/Always).',
    'At session start, choose "Ask Me" (confirm each action) or "Allow All" (auto-approve everything).',
    'Scheduled tasks always run in Allow All mode.',
  ];

  for (const p of perms) {
    sections.push(`  ${chalk.dim('•')} ${p}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Skills'));
  sections.push('');

  const skillInfo = [
    'Skills live in ~/.mercury/skills/<name>/SKILL.md',
    'Install: ask Mercury to "install skill from <url>" or paste content',
    'Invoke: ask Mercury to "use skill <name>"',
    'Schedule: "remind me daily at 9am to run daily-digest skill"',
  ];

  for (const s of skillInfo) {
    sections.push(`  ${chalk.dim('•')} ${s}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Scheduling'));
  sections.push('');

  const schedInfo = [
    'Recurring: "every day at 9am remind me to…"',
    'One-shot: "remind me in 15 seconds to…"',
    'Tasks persist to ~/.mercury/schedules.yaml',
  ];

  for (const s of schedInfo) {
    sections.push(`  ${chalk.dim('•')} ${s}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Configuration'));
  sections.push('');

  const configInfo = [
    ['~/.mercury/mercury.yaml', 'Main config (providers, channels, budget)'],
    ['~/.mercury/permissions.yaml', 'Capabilities and approval rules'],
    ['~/.mercury/soul/*.md', 'Agent personality (soul, persona, taste, heartbeat)'],
    ['~/.mercury/skills/', 'Installed skills'],
    ['~/.mercury/schedules.yaml', 'Scheduled tasks'],
    ['~/.mercury/token-usage.json', 'Daily token usage tracking'],
    ['~/.mercury/memory/', 'Short-term, long-term, episodic memory'],
  ];

  for (const [path, desc] of configInfo) {
    sections.push(`  ${chalk.dim(path.padEnd(36))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.dim('  mercury.cosmicstack.org'));
  sections.push('');

  return sections.join('\n');
}

/**
 * Telegram-specific help text — no chalk, no CLI-only commands.
 * Only shows commands that work on Telegram.
 */
export function getTelegramHelp(): string {
  const lines: string[] = [];

  lines.push('☿ **Mercury — Telegram Commands**');
  lines.push('');

  lines.push('**General**');
  lines.push('/help — Show this command list');
  lines.push('/status — Config, budget, and uptime');
  lines.push('/progress — Live status for the current task');
  lines.push('/permissions — Switch Ask Me / Allow All mode');
  lines.push('/models — List providers or switch AI model');
  lines.push('/stream — Toggle text streaming on/off');
  lines.push('');

  lines.push('**Budget**');
  lines.push('/budget — Show token budget status');
  lines.push('/budget override — Allow one request past budget');
  lines.push('/budget reset — Reset usage to zero');
  lines.push('/budget set <n> — Set daily token budget');
  lines.push('');

  lines.push('**Programming Mode**');
  lines.push('/code — Show current mode');
  lines.push('/code plan — Analyze and present options (no coding)');
  lines.push('/code execute — Implement step by step');
  lines.push('/code off — Exit programming mode');
  lines.push('/code toggle — Cycle: off → plan → execute → off');
  lines.push('/code agent <task> — Delegate coding to a sub-agent');
  lines.push('');

  lines.push('**Sub-Agents**');
  lines.push('/agents — List all sub-agents');
  lines.push('/agents stop <id|all> — Stop a sub-agent');
  lines.push('/agents pause <id> — Pause a sub-agent');
  lines.push('/agents resume <id> — Resume a sub-agent');
  lines.push('/halt — Emergency: stop all agents + clear queue');
  lines.push('/stop — Stop all + release locks + clear task board');
  lines.push('/reset — Full reset (stop all + clear context)');
  lines.push('');

  lines.push('**Background Tasks**');
  lines.push('/bg <command> — Run a shell command in background');
  lines.push('/bg: <task> — Delegate an LLM task to background');
  lines.push('/bg current — Move active task to background');
  lines.push('/bg list — Show all background tasks');
  lines.push('/bg <id> — Show task details');
  lines.push('/bg stop <id> — Stop a background task');
  lines.push('/bg killall — Stop all background tasks');
  lines.push('/bg clear — Remove completed tasks');
  lines.push('');

  lines.push('**Memory**');
  lines.push('/memory — View and manage second brain');
  lines.push('');

  lines.push('**Spotify**');
  lines.push('/spotify — Connection status');
  lines.push('/spotify auth — Connect Spotify');
  lines.push('/spotify code <code> — Complete auth with pasted code');
  lines.push('/spotify devices — List playback devices');
  lines.push('/spotify device <id> — Set active device');
  lines.push('/spotify now — Show currently playing');
  lines.push('/spotify logout — Disconnect Spotify');
  lines.push('');

  lines.push('**Access**');
  lines.push('/start — Request access to this Mercury instance');
  lines.push('/unpair — Reset all Telegram access (admin only)');

  return lines.join('\n');
}
