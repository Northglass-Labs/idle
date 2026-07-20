import { describe, expect, it } from 'vitest';
import { runShutdownHandlers, type ShutdownHandler } from './shutdown';

describe('shutdown ordering', () => {
    it('closes storage only after every drain handler has completed', async () => {
        const events: string[] = [];
        let releaseDrain!: () => void;
        const drainGate = new Promise<void>(resolve => {
            releaseDrain = resolve;
        });

        const handlers: ShutdownHandler[] = [
            {
                name: 'api',
                phase: 'drain',
                callback: async () => {
                    events.push('api-start');
                    await drainGate;
                    events.push('api-end');
                },
            },
            {
                name: 'background-work',
                phase: 'drain',
                callback: async () => {
                    events.push('background-end');
                },
            },
            {
                name: 'db',
                phase: 'storage',
                callback: async () => {
                    events.push('db-close');
                },
            },
        ];

        const shutdown = runShutdownHandlers(handlers);
        await vi.waitFor(() => {
            expect(events).toContain('api-start');
            expect(events).toContain('background-end');
        });
        expect(events).not.toContain('db-close');

        releaseDrain();
        await shutdown;

        expect(events.indexOf('db-close')).toBeGreaterThan(events.indexOf('api-end'));
        expect(events.indexOf('db-close')).toBeGreaterThan(events.indexOf('background-end'));
    });
});
