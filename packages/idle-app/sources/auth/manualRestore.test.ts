import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    login: vi.fn(), token: vi.fn(), dismissTo: vi.fn(), back: vi.fn(), alert: vi.fn(),
}));

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ dismissTo: mocks.dismissTo, back: mocks.back }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ login: mocks.login }) }));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: mocks.token }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: () => ({}) },
    useUnistyles: () => ({ theme: { colors: { input: { placeholder: '#888' } } } }),
}));
vi.mock('@/auth/authQRStart', () => ({}));
vi.mock('@/auth/authQRWait', () => ({}));
vi.mock('@/components/qr/QRCode', () => ({}));

import Restore from '@/app/(app)/restore/manual';

describe('manual account restore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.token.mockResolvedValue('restored-token');
        mocks.login.mockResolvedValue(undefined);
    });

    async function submit() {
        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => { renderer = TestRenderer.create(React.createElement(Restore)); });
        const secret = Buffer.alloc(32, 1).toString('base64url');
        await act(async () => {
            renderer.root.findByType('TextInput').props.onChangeText(secret);
        });
        await act(async () => { await renderer.root.findByType('RoundButton').props.action(); });
        await act(async () => renderer.unmount());
        return secret;
    }

    it('leaves the entire restore stack after credentials are saved', async () => {
        const secret = await submit();
        expect(mocks.login).toHaveBeenCalledWith('restored-token', secret);
        expect(mocks.dismissTo).toHaveBeenCalledWith('/');
        expect(mocks.back).not.toHaveBeenCalled();
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('stays on the restore form when authentication fails', async () => {
        mocks.token.mockResolvedValue(null);
        await submit();
        expect(mocks.login).not.toHaveBeenCalled();
        expect(mocks.dismissTo).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'connect.invalidSecretKey');
    });
});
