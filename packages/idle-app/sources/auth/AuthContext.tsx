import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence } from '@/sync/persistence';
import { loadRegisteredPushToken } from '@/sync/pushTokenStorage';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { setServerUrl, validateServerUrl } from '@/sync/serverConfig';
import { clearSessionReplayAnchor } from '@/sync/sessionReplayAnchor';
import { apiSocket } from '@/sync/apiSocket';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: (options?: LogoutOptions) => Promise<void>;
    switchServer: (url: string | null) => Promise<void>;
}

type LogoutOptions = {
    pushTokenAlreadyRemoved?: boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout, switchServer } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            // Persisted credentials establish the auth transition. Initial
            // sync is retryable and must not strand the user on the welcome
            // screen when the relay is temporarily unreachable.
            setCredentials(newCredentials);
            setIsAuthenticated(true);
            void syncCreate(newCredentials).catch(() => {
                console.warn('Account sync will retry in background');
            });
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const removeCredentialsAndShutdownAuth = async (failureMessage: string) => {
        const removed = await TokenStorage.removeCredentials();
        if (!removed) {
            throw new Error(failureMessage);
        }

        // Credential deletion is the commit point for local sign-out. Replay
        // state must remain intact until this succeeds; afterward, terminate
        // authenticated runtime access before any fallible cache cleanup.
        apiSocket.disconnect();
        setCredentials(null);
        setIsAuthenticated(false);
        setCurrentAuth(null);
    };

    const logout = async (options: LogoutOptions = {}) => {
        trackLogout();
        const registeredPushToken = credentials && !options.pushTokenAlreadyRemoved
            ? await loadRegisteredPushToken()
            : null;
        if (credentials && registeredPushToken) {
            try {
                await unregisterPushToken(credentials, registeredPushToken);
            } catch (error) {
                throw new Error(
                    'Could not remove this device push token. Logout was not completed; check the connection and try again.',
                    { cause: error },
                );
            }
        }
        await removeCredentialsAndShutdownAuth('Failed to clear credentials during logout');
        await clearSessionReplayAnchor();
        clearPersistence();

        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                // In dev mode, reloadAsync will throw ERR_UPDATES_DISABLED
                console.log('Development reload unavailable');
            }
        }
    };

    const switchServer = async (url: string | null) => {
        if (url !== null) {
            const validation = validateServerUrl(url);
            if (!validation.valid) {
                throw new Error(validation.error || 'Invalid server URL');
            }
        }

        // Cleanup must use the current origin. Never change getServerUrl()
        // while a bearer issued by that origin still exists locally.
        trackLogout();
        const registeredPushToken = credentials ? await loadRegisteredPushToken() : null;
        if (credentials && registeredPushToken) {
            try {
                await unregisterPushToken(credentials, registeredPushToken);
            } catch (error) {
                throw new Error(
                    'Could not remove this device push token. The server was not changed; check the connection and try again.',
                    { cause: error },
                );
            }
        }

        await removeCredentialsAndShutdownAuth('Failed to clear credentials before changing server');
        await clearSessionReplayAnchor();
        clearPersistence();
        setServerUrl(url);

        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                console.log('Development reload unavailable after server change');
            }
        }
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
                switchServer,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
