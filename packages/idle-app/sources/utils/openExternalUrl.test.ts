import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'web' },
    openUrl: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: mocks.platform,
    Linking: { openURL: mocks.openUrl },
}));

import { openExternalUrl } from './openExternalUrl';

describe('openExternalUrl', () => {
    beforeEach(() => {
        mocks.platform.OS = 'web';
        mocks.openUrl.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens web links in an isolated browser tab', async () => {
        const open = vi.fn();
        vi.stubGlobal('window', { open });

        await openExternalUrl('https://example.test');

        expect(open).toHaveBeenCalledWith(
            'https://example.test',
            '_blank',
            'noopener,noreferrer',
        );
        expect(mocks.openUrl).not.toHaveBeenCalled();
    });

    it('preserves native URL opening through React Native Linking', async () => {
        mocks.platform.OS = 'ios';

        await openExternalUrl('https://example.test');

        expect(mocks.openUrl).toHaveBeenCalledWith('https://example.test');
    });
});
