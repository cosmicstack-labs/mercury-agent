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
  ];

  for (const [name, desc, params] of tools) {
    sections.push(`  ${chalk.cyan(name.padEnd(24))} ${desc}`);
    sections.push(`  ${' '.repeat(24)} ${chalk.dim(params)}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  GitHub Tools'));
  sections.push(chalk.dim('  Available when GitHub is configured (mercury doctor).'));
  sections.push('');

  const githubTools = [
    ['create_pr', 'Create a pull request on GitHub', 'owner, repo, title, head, base, body?'],
    ['review_pr', 'Get PR details and post review comments', 'owner, repo, number'],
    ['list_issues', 'List repository issues', 'owner, repo, state?, labels?'],
    ['create_issue', 'Create a GitHub issue', 'owner, repo, title, body?, labels?'],
    ['github_api', 'Raw GitHub API access for any endpoint', 'method, endpoint, body?'],
  ];

  for (const [name, desc, params] of githubTools) {
    sections.push(`  ${chalk.cyan(name.padEnd(24))} ${desc}`);
    sections.push(`  ${' '.repeat(24)} ${chalk.dim(params)}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Spotify Tools'));
  sections.push(chalk.dim('  Control playback, search music, manage playlists. Requires Spotify connection.'));
  sections.push(chalk.dim('  Playback control (play, pause, skip, volume) requires Spotify Premium.'));
  sections.push('');

  const spotifyTools = [
    ['spotify_search', 'Search tracks, artists, albums, playlists', 'query, type?, limit?'],
    ['spotify_play', 'Play a track, album, or playlist on a device', 'uris?, context_uri?, device_id?'],
    ['spotify_pause', 'Pause playback', 'device_id?'],
    ['spotify_next', 'Skip to next track', 'device_id?'],
    ['spotify_previous', 'Skip to previous track', 'device_id?'],
    ['spotify_now_playing', 'Show what is currently playing', '—'],
    ['spotify_devices', 'List available Spotify devices', '—'],
    ['spotify_queue', 'Add a track to the playback queue', 'uri, device_id?'],
    ['spotify_like', 'Save the current track to your library', 'track_id'],
    ['spotify_volume', 'Set playback volume (0-100)', 'percent, device_id?'],
    ['spotify_shuffle', 'Toggle shuffle on/off', 'state (boolean), device_id?'],
    ['spotify_repeat', 'Set repeat mode (off/track/context)', 'state, device_id?'],
    ['spotify_top_tracks', 'Get your top tracks', 'time_range?, limit?'],
    ['spotify_playlists', 'Get your playlists', 'limit?'],
  ];

  for (const [name, desc, params] of spotifyTools) {
    sections.push(`  ${chalk.cyan(name.padEnd(24))} ${desc}`);
    sections.push(`  ${' '.repeat(24)} ${chalk.dim(params)}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Sub-Agent Tools'));
  sections.push(chalk.dim('  Delegate tasks to parallel agents. Use /agents to monitor.'));
  sections.push('');

  const agentTools = [
    ['delegate_task', 'Spawn a sub-agent to handle a task', 'task (description), context?'],
    ['list_agents', 'List all running and completed sub-agents', '—'],
    ['stop_agent', 'Stop a running sub-agent', 'agent_id'],
  ];

  for (const [name, desc, params] of agentTools) {
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
    ['/tasks', 'List scheduled tasks'],
    ['/memory', 'View and manage second brain memory'],
    ['/memory @username <query>', "Query a friend's shared memory via relay"],
    ['/stream', 'Toggle text streaming on/off (Telegram)'],
    ['/stream on', 'Enable streaming (live text updates)'],
    ['/stream off', 'Disable streaming (single message)'],
    ['/unpair', 'Reset all Telegram access for this Mercury instance (admins only)'],
  ];

  for (const [cmd, desc] of chat) {
    sections.push(`  ${chalk.white(cmd.padEnd(16))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Sub-Agent Commands'));
  sections.push(chalk.dim('  Manage parallel AI agents spawned by the delegate_task tool.'));
  sections.push('');

  const subagentCmds = [
    ['/agents', 'List all sub-agents (running and completed)'],
    ['/halt', 'Emergency: halt all sub-agents and clear the task queue'],
    ['/stop', 'Halt all agents, clear queue, release file locks, reset task board'],
  ];

  for (const [cmd, desc] of subagentCmds) {
    sections.push(`  ${chalk.white(cmd.padEnd(16))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Programming Mode'));
  sections.push(chalk.dim('  Plan-first workflow for code changes. Mercury analyzes before writing.'));
  sections.push('');

  const codeCmds = [
    ['/code plan', 'Analyze the task and present a plan (no code changes)'],
    ['/code execute', 'Implement the plan step by step'],
    ['/code off', 'Exit programming mode (back to normal)'],
    ['/code toggle', 'Cycle through modes (off → plan → execute → off)'],
    ['/code status', 'Show current programming mode'],
  ];

  for (const [cmd, desc] of codeCmds) {
    sections.push(`  ${chalk.white(cmd.padEnd(16))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Spotify Commands'));
  sections.push(chalk.dim('  Control Spotify playback and manage your connection.'));
  sections.push(chalk.dim('  Playback control requires Spotify Premium. Read-only works on free accounts.'));
  sections.push('');

  const spotifyCmds = [
    ['/spotify', 'Show connection status, account, and plan'],
    ['/spotify auth', 'Connect Spotify (browser or manual code flow)'],
    ['/spotify code <code>', 'Complete auth with a pasted authorization code (for SSH/Telegram)'],
    ['/spotify logout', 'Disconnect Spotify and clear saved tokens'],
    ['/spotify player', 'Interactive music player (CLI only: arrow-key controls, search, queue)'],
    ['/spotify devices', 'List available Spotify devices'],
    ['/spotify device <id>', 'Set active Spotify device'],
    ['/spotify now', 'Show what is currently playing'],
  ];

  for (const [cmd, desc] of spotifyCmds) {
    sections.push(`  ${chalk.white(cmd.padEnd(24))} ${desc}`);
  }

  sections.push('');
  sections.push(chalk.bold.white('  Permissions'));
  sections.push('');

  const perms = [
    'Commands are blocked (never run), auto-approved, or need approval.',
    'Say "always" when prompted to permanently approve a command type.',
    'Edit ~/.mercury/permissions.yaml to customize manually.',
    'File access is scoped — new paths need approval (y/n/always).',
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