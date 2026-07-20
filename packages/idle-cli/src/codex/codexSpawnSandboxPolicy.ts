export type CodexSpawnSandboxPolicy =
    | 'idle-managed'
    | 'provider-native-approval-required'
    | 'provider-native';

export function resolveCodexSpawnSandboxPolicy(options: {
    agent: string | undefined;
    idleSandboxEnabled: boolean;
    providerNativeSandboxApproved: boolean;
    hasExplicitSandboxCredential: boolean;
    hasKeyringChatGptLogin: boolean;
}): CodexSpawnSandboxPolicy {
    if (options.agent !== 'codex' || !options.idleSandboxEnabled) {
        return 'idle-managed';
    }
    if (options.providerNativeSandboxApproved) {
        return 'provider-native';
    }
    if (!options.hasExplicitSandboxCredential && options.hasKeyringChatGptLogin) {
        return 'provider-native-approval-required';
    }
    return 'idle-managed';
}
