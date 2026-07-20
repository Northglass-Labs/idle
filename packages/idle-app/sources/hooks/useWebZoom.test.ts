import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

import { BROWSER_APP_ZOOM, getBrowserAppZoomValue } from './useWebZoom';

describe('useWebZoom browser defaults', () => {
    it('keeps browser web zoom fixed at 1x', () => {
        expect(BROWSER_APP_ZOOM).toBe(1);
        expect(getBrowserAppZoomValue()).toBe('1');
    });
});
