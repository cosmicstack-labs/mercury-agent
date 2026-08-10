import chalk from 'chalk';
import { loadConfig, saveConfig, updateConfig, type MercuryConfig } from '../utils/config.js';
import { openUrl } from '../utils/open-url.js';
import { PairingFailureError, startPairingFlow, pollPairingComplete, refreshToken, redeemAgentApiKey } from './pairing.js';
import { clearCloudTokenStore, getCloudTokenStore, initCloudTokenStore } from './token-store.js';
import type { CloudConfig } from './types.js';
import { MERCURY_CLOUD_API_URL, MERCURY_CLOUD_WS_URL } from './endpoints.js';
import { getDaemonStatus, getForegroundRuntimeStatus, startBackground, stopDaemon } from '../cli/daemon.js';
import { isServiceInstalled, isServiceRunning, restartService, stopService } from '../cli/service.js';
import { clearCloudRuntimeOnline, isCloudRuntimeOnline, waitForCloudRuntimeOnline } from './runtime-status.js';

/**
 * After fresh credentials land in `config.cloud`, sync the shared in-memory
 * token store (if one exists in this process) so the running WS client and
 * provider pick up the new tokens without a restart.
 */
function syncTokenStore(config: MercuryConfig): void {
  if (config.cloud.enabled && config.cloud.jwt && config.cloud.agentId) {
    const existing = getCloudTokenStore();
    if (existing?.matchesIdentity(config.cloud.apiUrl, config.cloud.agentId)) {
      existing.setAgentApiKey(config.cloud.agentApiKey);
      existing.setTokens(config.cloud.jwt, config.cloud.refreshToken);
    } else {
      initCloudTokenStore(config);
    }
  }
}

export async function runCloudPairingFlow(
  config: MercuryConfig
): Promise<{ cloudConfig: CloudConfig; model: string } | null> {
  const apiUrl = config.cloud.apiUrl || MERCURY_CLOUD_API_URL;

  console.log(chalk.dim('  Starting terminal pairing flow...'));
  console.log('');

  const { code, pairingUrl } = await startPairingFlow(apiUrl, undefined);

  console.log(chalk.white('  Open this URL in your browser to register and connect:'));
  console.log(chalk.cyan(`  ${pairingUrl}`));
  console.log('');
  console.log(chalk.dim(`  Pairing code: ${code}`));

  void tryOpenBrowser(pairingUrl);

  console.log(chalk.dim('  Waiting for approval (timeout in 5 minutes)...'));

  let result;
  try {
    result = await pollPairingComplete(apiUrl, code);
  } catch (err: any) {
    console.log('');
    console.log(chalk.red(`  ✗ Pairing failed: ${err.message}`));
    if (err instanceof PairingFailureError && err.details.code === 'AGENT_LIMIT_REACHED') {
      const nextTier = err.details.nextTier ? err.details.nextTier.charAt(0).toUpperCase() + err.details.nextTier.slice(1) : null;
      if (typeof err.details.used === 'number' && typeof err.details.limit === 'number') {
        console.log(chalk.yellow(`    Agent capacity: ${err.details.used} of ${err.details.limit} slots used`));
      }
      if (nextTier && err.details.upgradeUrl) {
        console.log(chalk.white(`    Upgrade to ${nextTier} to connect another agent:`));
        console.log(chalk.cyan(`    ${err.details.upgradeUrl}`));
        console.log(chalk.dim('    After upgrading, run `mercury cloud connect` again.'));
      } else {
        console.log(chalk.white('    Remove an existing agent from Mercury Cloud, then run `mercury cloud connect` again.'));
      }
    }
    console.log('');
    if (!(err instanceof PairingFailureError && err.details.code === 'AGENT_LIMIT_REACHED')) {
      console.log(chalk.dim('  If the browser did not open automatically, copy this URL:'));
      console.log(chalk.cyan(`  ${pairingUrl}`));
    }
    return null;
  }

  const cloudConfig: CloudConfig = {
    enabled: true,
    apiUrl,
    wsUrl: config.cloud.wsUrl || MERCURY_CLOUD_WS_URL,
    jwt: result.jwt,
    refreshToken: result.refreshToken,
    agentId: result.agentId,
    tier: result.tier || 'free',
    agentApiKey: result.apiKey || '',
  };

  let model = 'mercury-flash';
  try {
    const res = await fetch(`${apiUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${result.jwt}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string; label: string; discount_percent?: number }> };
      const models = data.data;
      if (models && models.length > 0) {
        console.log(chalk.dim('  Available models:'));
        for (let i = 0; i < models.length; i++) {
          const discount = models[i].discount_percent;
          const discountTag = discount && discount > 0 ? chalk.green(` (${discount}% off input)`) : '';
          console.log(chalk.white(`    ${i + 1}. ${models[i].label} (${models[i].id})`) + discountTag);
        }
        console.log('');
        const choice = await import('readline').then(async (rl) => {
          const r = rl.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<string>((resolve) => {
            r.question(chalk.white(`  Choose a model [1-${models.length}, Enter for 1]: `), (ans) => {
              r.close();
              resolve(ans || '1');
            });
          });
        });
        const idx = parseInt(choice, 10) - 1;
        if (idx >= 0 && idx < models.length) {
          model = models[idx].id;
        }
      }
    }
  } catch {
  }

  return { cloudConfig, model };
}

export async function runCloudConnect(): Promise<void> {
  const config = loadConfig();

  if (config.cloud.enabled && config.cloud.jwt) {
    // Validate the token is actually usable — don't just trust local config
    const valid = await validateCloudConnection(config);

    if (valid) {
      console.log(chalk.green('  ✓ Mercury Cloud is already connected.'));
      console.log(chalk.dim(`    Agent ID: ${config.cloud.agentId}`));
      console.log(chalk.dim(`    Tier: ${config.cloud.tier || 'free'}`));
      console.log(chalk.dim(`    API URL: ${config.cloud.apiUrl}`));
      // Ensure a background daemon is running so the WebSocket stays alive
      // even after the user exits the foreground TUI.
      await activateCloudRuntime(config.cloud.agentId, false);
      return;
    }

    // Token is expired/invalid — try to refresh
    if (config.cloud.refreshToken) {
      console.log(chalk.yellow('  ⚠ Mercury Cloud token expired. Refreshing...'));
      let refreshed = false;
      try {
        const result = await refreshToken(config.cloud.apiUrl, config.cloud.refreshToken);
        config.cloud.jwt = result.jwt;
        config.cloud.refreshToken = result.refreshToken;
        config.providers.mercuryCloud.apiKey = result.jwt;
        saveConfig(config);
        syncTokenStore(config);

        // Re-validate with the fresh token
        const validNow = await validateCloudConnection(config);
        if (validNow) {
          console.log(chalk.green('  ✓ Mercury Cloud token refreshed successfully.'));
          console.log(chalk.dim(`    Agent ID: ${config.cloud.agentId}`));
          console.log(chalk.dim(`    API URL: ${config.cloud.apiUrl}`));
          refreshed = true;
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ Token refresh failed: ${err.message}`));
      }
      if (refreshed) {
        // Token refreshed — restart daemon so it picks up the new token.
        await activateCloudRuntime(config.cloud.agentId, true);
        return;
      }
    }

    // Refresh token is dead — try redeeming the long-lived agent API key
    // before forcing a full browser re-pair. This is the self-recovery path
    // that keeps remotely-deployed agents online without manual intervention.
    if (config.cloud.agentApiKey) {
      console.log(chalk.yellow('  ⚠ Trying agent API key recovery...'));
      let recovered = false;
      try {
        const result = await redeemAgentApiKey(config.cloud.apiUrl, config.cloud.agentApiKey);
        if (!result.agentId || result.agentId !== config.cloud.agentId) {
          throw new Error('Agent API key identity mismatch; browser re-pairing is required');
        }
        config.cloud.jwt = result.jwt;
        config.cloud.refreshToken = result.refreshToken;
        config.providers.mercuryCloud.apiKey = result.jwt;
        saveConfig(config);
        syncTokenStore(config);
        const validNow = await validateCloudConnection(config);
        if (validNow) {
          console.log(chalk.green('  ✓ Recovered via agent API key.'));
          console.log(chalk.dim(`    Agent ID: ${config.cloud.agentId}`));
          console.log(chalk.dim(`    API URL: ${config.cloud.apiUrl}`));
          recovered = true;
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ Agent API key recovery failed: ${err.message}`));
      }
      if (recovered) {
        // Recovered — restart daemon so it picks up the new token.
        await activateCloudRuntime(config.cloud.agentId, true);
        return;
      }
    }

    // Refresh + agent key both failed — re-pair
    console.log(chalk.yellow('  ⚠ Session expired. Starting re-pairing flow...'));
    config.cloud.enabled = false;
    config.cloud.jwt = '';
    config.cloud.refreshToken = '';
  }

  const result = await runCloudPairingFlow(config);
  if (!result) {
    console.log(chalk.red('  ✗ Pairing failed. See error above.'));
    return;
  }

  const previousDefault = config.providers.default;
  const pairedConfig = updateConfig((latest) => {
    latest.cloud = result.cloudConfig;
    latest.providers.mercuryCloud.apiKey = result.cloudConfig.jwt;
    latest.providers.mercuryCloud.model = result.model;
    latest.providers.mercuryCloud.enabled = true;
    latest.providers.default = 'mercuryCloud';
  });
  if (previousDefault !== 'mercuryCloud') {
    console.log(chalk.dim(`  Switching default provider to Mercury Cloud (was ${previousDefault})`));
  }
  syncTokenStore(pairedConfig);

  console.log(chalk.green('  ✓ Mercury Cloud connected!'));
  console.log(chalk.dim(`    Agent ID: ${result.cloudConfig.agentId}`));
  console.log(chalk.dim(`    Tier: ${result.cloudConfig.tier}`));
  console.log(chalk.dim(`    Model: ${result.model}`));
  console.log('');
  // Start a background daemon so the WebSocket stays alive even after the
  // user exits the foreground TUI. This is the original behavior — the daemon
  // handles failovers, message queuing, and keeps the agent online on the
  // cloud dashboard.
  await activateCloudRuntime(result.cloudConfig.agentId, true);
}

export async function runCloudDisconnect(): Promise<void> {
  const daemonWasRunning = getDaemonStatus().running;
  const foregroundWasRunning = getForegroundRuntimeStatus().running;
  const serviceWasRunning = isServiceRunning();
  const runtimeWasRunning = daemonWasRunning || foregroundWasRunning || serviceWasRunning;
  if (foregroundWasRunning) {
    throw new Error('Mercury is running in the foreground. Stop that session before disconnecting Cloud so in-memory credentials cannot remain active');
  }
  if (daemonWasRunning) {
    console.log(chalk.dim('  Stopping the running agent before clearing Cloud credentials...'));
    const stopped = await stopDaemon();
    if (!stopped) {
      throw new Error('Could not stop the running Mercury daemon; Cloud credentials were not changed');
    }
  } else if (serviceWasRunning && !stopService()) {
    throw new Error('Could not stop the Mercury system service; Cloud credentials were not changed');
  }
  clearCloudRuntimeOnline();

  let config = loadConfig();
  const hadCloudState = config.cloud.enabled
    || !!config.cloud.jwt
    || !!config.cloud.refreshToken
    || !!config.cloud.agentId
    || !!config.cloud.agentApiKey
    || config.providers.mercuryCloud.enabled
    || !!config.providers.mercuryCloud.apiKey;

  config = updateConfig((latest) => {
    latest.cloud.enabled = false;
    latest.cloud.jwt = '';
    latest.cloud.refreshToken = '';
    latest.cloud.agentId = '';
    latest.cloud.agentApiKey = '';
    latest.providers.mercuryCloud.enabled = false;
    latest.providers.mercuryCloud.apiKey = '';

    if (latest.providers.default !== 'mercuryCloud') return;
    const configured = Object.values(latest.providers)
      .filter((p): p is import('../utils/config.js').ProviderConfig =>
        typeof p === 'object' && p.name !== 'mercuryCloud' && isProviderConfiguredSafe(p)
      );
    if (configured.length > 0) {
      latest.providers.default = configured[0].name as import('../utils/config.js').ProviderName;
      console.log(chalk.dim(`  Default provider switched to ${configured[0].name}`));
    } else {
      console.log(chalk.yellow('  No other providers configured. Run `mercury setup` to configure offline providers.'));
    }
  });
  clearCloudTokenStore();
  console.log(hadCloudState
    ? chalk.green('  ✓ Local Mercury Cloud credentials cleared.')
    : chalk.yellow('  Mercury Cloud was already disconnected; stale credentials were scrubbed.'));
  console.log(chalk.dim('  The cloud agent remains registered remotely. Delete it in the dashboard to revoke server-side credentials.'));

  const hasOfflineProvider = Object.values(config.providers).some((provider) =>
    typeof provider === 'object' && provider.name !== 'mercuryCloud' && isProviderConfiguredSafe(provider)
  );
  if (runtimeWasRunning && hasOfflineProvider) {
    console.log(chalk.dim('  Restarting Mercury with the configured offline provider...'));
    startManagedRuntime();
  } else if (runtimeWasRunning) {
    console.log(chalk.yellow('  Mercury remains stopped because no offline provider is configured.'));
  } else {
    console.log(chalk.dim('  Stop any foreground Mercury process to discard its in-memory Cloud session.'));
  }
}

export async function runCloudStatus(): Promise<void> {
  const config = loadConfig();

  if (!config.cloud.enabled) {
    console.log(chalk.yellow('  Mercury Cloud: not connected (offline/BYOK mode)'));
    return;
  }

  console.log(chalk.green('  Mercury Cloud: connected'));
  console.log(chalk.dim(`    Agent ID: ${config.cloud.agentId}`));
  console.log(chalk.dim(`    Tier: ${config.cloud.tier}`));
  console.log(chalk.dim(`    API URL: ${config.cloud.apiUrl}`));
  console.log(chalk.dim(`    WS URL: ${config.cloud.wsUrl}`));
  console.log(chalk.dim(`    Model: ${config.providers.mercuryCloud.model}`));
  console.log(chalk.dim(`    JWT: ${config.cloud.jwt.slice(0, 12)}...`));

  try {
    const res = await fetch(`${config.cloud.apiUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${config.cloud.jwt}` },
    });
    if (res.ok) {
      const usage = await res.json() as { todayTokens: number; credits: number };
      console.log(chalk.dim(`    Today tokens: ${usage.todayTokens}`));
      console.log(chalk.dim(`    Credits: ${usage.credits}`));
    }
  } catch {
  }
}

export async function runCloudLogin(): Promise<void> {
  const config = loadConfig();

  if (!config.cloud.refreshToken) {
    console.log(chalk.yellow('  No refresh token found. Run `mercury cloud connect` to pair.'));
    return;
  }

  try {
    const { refreshToken: doRefresh } = await import('./pairing.js');
    const result = await doRefresh(config.cloud.apiUrl, config.cloud.refreshToken);
    config.cloud.jwt = result.jwt;
    config.cloud.refreshToken = result.refreshToken;
    config.providers.mercuryCloud.apiKey = result.jwt;
    saveConfig(config);
    syncTokenStore(config);
    console.log(chalk.green('  ✓ Token refreshed successfully.'));
  } catch (err: any) {
    console.log(chalk.red(`  ✗ Token refresh failed: ${err.message || err}`));
    console.log(chalk.yellow('  Run `mercury cloud connect` to re-pair.'));
    return;
  }
  // Restart daemon so it picks up the new token.
  await activateCloudRuntime(config.cloud.agentId, true);
}

async function activateCloudRuntime(agentId: string, credentialsChanged: boolean): Promise<void> {
  const foreground = getForegroundRuntimeStatus();
  const daemon = getDaemonStatus();
  const serviceRunning = isServiceRunning();
  const hadManagedRuntime = daemon.running || serviceRunning;

  if (foreground.running) {
    if (!credentialsChanged && isCloudRuntimeOnline(agentId, 'foreground')) {
      console.log(chalk.green(`  Mercury Cloud WebSocket is already online in foreground PID ${foreground.pid}.`));
      return;
    }
    if (!hadManagedRuntime) {
      throw new Error('Cloud credentials were saved, but Mercury is running only in the foreground. Restart that foreground session to activate its Cloud WebSocket');
    }
    console.log(chalk.yellow(`  Foreground Mercury (PID: ${foreground.pid}) keeps its local session while the managed Cloud runtime restarts.`));
  }
  clearCloudRuntimeOnline();

  if (daemon.running) {
    console.log(chalk.dim(`  Restarting Mercury (PID: ${daemon.pid}) to activate Cloud...`));
    if (!await stopDaemon()) {
      throw new Error('Cloud credentials were saved, but the running Mercury process could not be restarted');
    }
  }
  startManagedRuntime();
  if (!await waitForCloudRuntimeOnline(agentId, 20_000, 'daemon')) {
    throw new Error('Mercury restarted, but its Cloud WebSocket did not become online within 20 seconds');
  }
  console.log(chalk.green('  ✓ Mercury daemon restarted with Cloud credentials.'));
}

function startManagedRuntime(): void {
  if (isServiceInstalled()) {
    restartService();
  } else {
    startBackground();
  }
}

function isProviderConfiguredSafe(p: import('../utils/config.js').ProviderConfig): boolean {
  if (!p.enabled) return false;
  if (p.name === 'ollamaLocal') return p.baseUrl.length > 0 && p.model.length > 0;
  if (p.name === 'ollamaCloud') return p.apiKey.length > 0 && p.baseUrl.length > 0;
  if (p.name === 'openaiCompat') return p.baseUrl.length > 0 && p.model.length > 0;
  if (p.name === 'chatgptWeb' || p.name === 'githubCopilot') return p.model.length > 0;
  return p.apiKey.length > 0;
}

async function tryOpenBrowser(url: string): Promise<void> {
  if (await openUrl(url)) {
    console.log(chalk.green('  ✓ Opened in browser.'));
  } else {
    console.log(chalk.dim('  Could not open browser automatically. Please open the URL manually.'));
  }
}

async function validateCloudConnection(config: MercuryConfig): Promise<boolean> {
  try {
    const res = await fetch(`${config.cloud.apiUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${config.cloud.jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
