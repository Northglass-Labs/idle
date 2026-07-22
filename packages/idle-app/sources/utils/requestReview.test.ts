import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    applySettings: vi.fn(),
    confirm: vi.fn(async () => false),
    isAvailableAsync: vi.fn(),
    requestStoreReview: vi.fn(),
}));

vi.mock('expo-store-review', () => ({
    isAvailableAsync: mocks.isAvailableAsync,
    requestReview: mocks.requestStoreReview,
}));

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString() { return undefined; }
        set() {}
        delete() {}
    },
}));

vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/track', () => ({
    trackReviewPromptShown: vi.fn(),
    trackReviewPromptResponse: vi.fn(),
    trackReviewStoreShown: vi.fn(),
    trackReviewRetryScheduled: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: mocks.applySettings } }));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            settings: {
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
            },
        }),
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { requestReview } from './requestReview';

describe('requestReview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not open a review modal after the owning screen is dismissed', async () => {
        let resolveAvailability!: (available: boolean) => void;
        mocks.isAvailableAsync.mockReturnValue(new Promise<boolean>((resolve) => {
            resolveAvailability = resolve;
        }));
        const controller = new AbortController();

        const pending = requestReview({ signal: controller.signal });
        expect(pending).toBeInstanceOf(Promise);

        controller.abort();
        resolveAvailability(true);
        await pending;

        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.requestStoreReview).not.toHaveBeenCalled();
    });
});
