export const IDLE_SENSITIVE_FILE_NAMES = [
    'access.key',
    'agent.key',
    'settings.json',
    'settings.json.lock',
    'daemon.state.json',
    'daemon.state.json.lock',
    'sessions.json',
    'rpc-replay-v1',
    'message-replay-v1',
    '.message-replay-v1.initialized',
] as const;

export const DEFAULT_IDLE_SENSITIVE_READ_PATHS = IDLE_SENSITIVE_FILE_NAMES.map(
    (fileName) => `~/.idle/${fileName}`,
);

/** Credential stores and browser profiles denied to remote agent sessions. */
export const DEFAULT_SANDBOX_DENY_READ_PATHS = [
    '~/.ssh',
    '~/.aws',
    '~/.gnupg',
    '~/.azure',
    '~/.kube',
    '~/.docker',
    '~/.netrc',
    '~/.npmrc',
    '~/.pypirc',
    '~/.config/gh',
    '~/.config/gcloud',
    '~/.config/op',
    '~/.config/1Password',
    '~/.password-store',
    '~/.local/share/keyrings',
    '~/Library/Group Containers/2BUA8C4S2C.com.1password',
    '~/Library/Application Support/Google/Chrome',
    '~/Library/Application Support/Chromium',
    '~/Library/Application Support/BraveSoftware',
    '~/Library/Application Support/Firefox/Profiles',
    '~/.mozilla',
    '~/.config/google-chrome',
    '~/.config/chromium',
    '~/.config/BraveSoftware',
    ...DEFAULT_IDLE_SENSITIVE_READ_PATHS,
] as const;

/** Provider endpoints available under the automatic provider-only policy. */
export const DEFAULT_SANDBOX_PROVIDER_DOMAINS = [
    'api.anthropic.com',
    '*.anthropic.com',
    'api.openai.com',
    '*.openai.com',
    'chatgpt.com',
    '*.chatgpt.com',
    'generativelanguage.googleapis.com',
    '*.googleapis.com',
] as const;
