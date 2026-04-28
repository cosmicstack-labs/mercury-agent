import { logger } from './logger.js';

const GITHUB_API = 'https://api.github.com';

let cachedToken: string | null = null;

export function setGitHubToken(token: string): void {
  cachedToken = token;
}

function getGitHubToken(): string | null {
  if (cachedToken) return cachedToken;
  return process.env.GITHUB_TOKEN || null;
}

export function isGitHubConfigured(): boolean {
  return !!getGitHubToken();
}

interface GitHubRequestOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
}

export async function githubRequest(path: string, options: GitHubRequestOptions = {}): Promise<any> {
  const token = getGitHubToken();
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured. Run mercury doctor to set it up.');
  }

  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Mercury-Agent',
    ...options.headers,
  };

  const fetchOptions: any = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  logger.info({ method: fetchOptions.method, path }, 'GitHub API request');

  const response = await fetch(url, fetchOptions);

  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining && parseInt(remaining, 10) < 100) {
    logger.warn({ remaining }, 'GitHub API rate limit running low');
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}