import chalk from 'chalk';
import { loadConfig, saveConfig, type MercuryConfig } from '../utils/config.js';
import { openUrl } from '../utils/open-url.js';
import { PairingFailureError, startPairingFlow, pollPairingComplete, refreshToken, redeemAgentApiKey } from './pairing.js';
import { getCloudTokenStore, initCloudTokenStore } from './token-store.js';
import type { CloudConfig } from './types.js';
import { MERCURY_CLOUD_API_URL, MERCURY_CLOUD_WS_URL } from './endpoints.js';

/**
 * After fresh credentials land in `config.cloud`, sync the shared in-memory
 * token store (if one exists in this process) so the running WS client and
 * provider pick up the new tokens without a restart.
 */
function syncTokenStore(config: MercuryConfig): void {
  if (config.cloud.enabled && config.cloud.jwt && config.cloud.agentId) {
    const existing = getCloudTokenStore();
    if (existing) {
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
    agentApiKey: result.apiKey || config.cloud.agentApiKey || '',
  };

  let model = 'mercury-flash';
  try {
    const res = await fetch(`${apiUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${result.jwt}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ id: string; label: string }> };
      if (data.models && data.models.length > 0) {
        console.log(chalk.dim('  Available models:'));
        for (let i = 0; i < data.models.length; i++) {
          console.log(chalk.white(`    ${i + 1}. ${data.models[i].label} (${data.models[i].id})`));
        }
        console.log('');
        const choice = await import('readline').then(async (rl) => {
          const r = rl.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<string>((resolve) => {
            r.question(chalk.white(`  Choose a model [1-${data.models!.length}, Enter for 1]: `), (ans) => {
              r.close();
              resolve(ans || '1');
            });
          });
        });
        const idx = parseInt(choice, 10) - 1;
        if (idx >= 0 && idx < data.models.length) {
          model = data.models[idx].id;
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
      return;
    }

    // Token is expired/invalid — try to refresh
    if (config.cloud.refreshToken) {
      console.log(chalk.yellow('  ⚠ Mercury Cloud token expired. Refreshing...'));
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
          return;
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ Token refresh failed: ${err.message}`));
      }
    }

    // Refresh token is dead — try redeeming the long-lived agent API key
    // before forcing a full browser re-pair. This is the self-recovery path
    // that keeps remotely-deployed agents online without manual intervention.
    if (config.cloud.agentApiKey) {
      console.log(chalk.yellow('  ⚠ Trying agent API key recovery...'));
      try {
        const result = await redeemAgentApiKey(config.cloud.apiUrl, config.cloud.agentApiKey);
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
          return;
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ Agent API key recovery failed: ${err.message}`));
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

  config.cloud = result.cloudConfig;
  config.providers.mercuryCloud.apiKey = result.cloudConfig.jwt;
  config.providers.mercuryCloud.model = result.model;
  config.providers.mercuryCloud.enabled = true;
  if (config.providers.default !== 'mercuryCloud') {
    console.log(chalk.dim(`  Switching default provider to Mercury Cloud (was ${config.providers.default})`));
    config.providers.default = 'mercuryCloud';
  }
  saveConfig(config);
  syncTokenStore(config);

  console.log(chalk.green('  ✓ Mercury Cloud connected!'));
  console.log(chalk.dim(`    Agent ID: ${result.cloudConfig.agentId}`));
  console.log(chalk.dim(`    Tier: ${result.cloudConfig.tier}`));
  console.log(chalk.dim(`    Model: ${result.model}`));
  console.log('');
  console.log(chalk.cyan('  Mercury Cloud is ready!'));
  console.log(chalk.yellow('  Run `mercury start` to begin using your agent.'));
}

export async function runCloudDisconnect(): Promise<void> {
  const config = loadConfig();

  if (!config.cloud.enabled) {
    console.log(chalk.yellow('  Mercury Cloud is not connected.'));
    return;
  }

  config.cloud.enabled = false;
  config.cloud.jwt = '';
  config.cloud.refreshToken = '';
  config.cloud.agentId = '';
  config.cloud.agentApiKey = '';
  config.providers.mercuryCloud.enabled = false;
  config.providers.mercuryCloud.apiKey = '';

  if (config.providers.default === 'mercuryCloud') {
    const configured = Object.values(config.providers)
      .filter((p): p is import('../utils/config.js').ProviderConfig =>
        typeof p === 'object' && p.name !== 'mercuryCloud' && isProviderConfiguredSafe(p)
      );
    if (configured.length > 0) {
      config.providers.default = configured[0].name as import('../utils/config.js').ProviderName;
      console.log(chalk.dim(`  Default provider switched to ${configured[0].name}`));
    } else {
      console.log(chalk.yellow('  No other providers configured. Run `mercury setup` to configure offline providers.'));
    }
  }

  saveConfig(config);
  console.log(chalk.green('  ✓ Mercury Cloud disconnected. Offline (BYOK) mode active.'));
  console.log(chalk.yellow('  Restart Mercury: `mercury restart`'));
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
