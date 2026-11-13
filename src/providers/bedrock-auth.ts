import type { ProviderConfig } from '../utils/config.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * AWS credentials for Bedrock from the standard Node credential chain: env
 * keys, a named profile, IAM Identity Center (SSO), assumed roles, the
 * credential_process hook, and container or instance roles. The chain caches
 * and refreshes temporary credentials itself, so an SSO session that is
 * renewed with `aws sso login` is picked up without restarting Mercury.
 *
 * Loaded lazily so users of other providers never load the AWS SDK.
 */
export function bedrockCredentialProvider(config: ProviderConfig): () => Promise<AwsCredentials> {
  let chain: (() => Promise<AwsCredentials>) | undefined;
  return async () => {
    let resolve = chain;
    if (!resolve) {
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
      resolve = defaultProvider(config.awsProfile ? { profile: config.awsProfile } : {});
      chain = resolve;
    }
    const { accessKeyId, secretAccessKey, sessionToken } = await resolve();
    return { accessKeyId, secretAccessKey, sessionToken };
  };
}

export function bedrockRegion(config: ProviderConfig): string {
  return config.region || 'us-east-1';
}
