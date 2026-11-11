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
  let chain: Promise<() => Promise<AwsCredentials>> | undefined;
  return async () => {
    chain ??= import('@aws-sdk/credential-provider-node').then(({ defaultProvider }) =>
      defaultProvider(config.awsProfile ? { profile: config.awsProfile } : {}),
    );
    const resolve = await chain;
    const { accessKeyId, secretAccessKey, sessionToken } = await resolve();
    return { accessKeyId, secretAccessKey, sessionToken };
  };
}

export function bedrockRegion(config: ProviderConfig): string {
  const region = config.region?.trim() || 'us-east-1';
  if (!/^[a-z]+(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw new Error('Invalid Bedrock region. Use an AWS region identifier such as us-east-1.');
  }
  return region;
}
