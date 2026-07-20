export type AgentEnvironmentProfile = 'claude' | 'gemini' | 'acp';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const OPERATIONAL_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

const CLAUDE_PROVIDER_ENVIRONMENT_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUD_ML_REGION',
]);

const GEMINI_PROVIDER_ENVIRONMENT_KEYS = new Set([
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
]);

function isProviderScopedKey(profile: AgentEnvironmentProfile, key: string): boolean {
  switch (profile) {
    case 'claude':
      return key.startsWith('ANTHROPIC_')
        || key.startsWith('CLAUDE_')
        || CLAUDE_PROVIDER_ENVIRONMENT_KEYS.has(key);
    case 'gemini':
      return key.startsWith('GEMINI_')
        || GEMINI_PROVIDER_ENVIRONMENT_KEYS.has(key);
    case 'acp':
      return key.startsWith('ACP_');
  }
}

function copyEnvironmentValue(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (typeof value === 'string' && ENVIRONMENT_NAME.test(key)) {
    target[key] = value;
  }
}

/**
 * Build the default child environment for a coding-agent process.
 *
 * The Idle daemon can hold credentials for unrelated providers and host tools.
 * Passing its entire environment to an agent would make those values readable
 * without any filesystem access. Keep only process-operational values and the
 * selected provider's documented credential namespace. Explicit per-session
 * values remain supported and win over inherited values.
 */
export function buildAgentChildEnvironment(
  profile: AgentEnvironmentProfile,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  explicitEnvironment?: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (
      OPERATIONAL_ENVIRONMENT_KEYS.has(key)
      || /^LC_[A-Z0-9_]+$/.test(key)
      || isProviderScopedKey(profile, key)
    ) {
      copyEnvironmentValue(environment, key, value);
    }
  }

  for (const [key, value] of Object.entries(explicitEnvironment ?? {})) {
    copyEnvironmentValue(environment, key, value);
  }

  return environment;
}
