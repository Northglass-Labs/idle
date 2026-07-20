import { expect, test as base } from '@playwright/test';

import { SERVER_URL } from './liveTarget';

type BrowserEgressFixture = {
    browserEgressGuard: void;
};

type BlockedEgress = {
    http: number;
    productionRelay: number;
    websocket: number;
};

function isProductionRelay(url: URL): boolean {
    return url.hostname.toLowerCase() === 'idle-api.northglass.io';
}

function comparableOrigin(url: URL): string {
    if (url.protocol === 'ws:') return `http://${url.host}`;
    if (url.protocol === 'wss:') return `https://${url.host}`;
    return url.origin;
}

export const test = base.extend<BrowserEgressFixture>({
    browserEgressGuard: [async ({ page, baseURL }, use, testInfo) => {
        if (!baseURL) {
            throw new Error('Idle browser E2E tests require a configured baseURL');
        }

        const allowedOrigins = new Set([
            new URL(baseURL).origin,
            new URL(SERVER_URL).origin,
        ]);
        const blocked: BlockedEgress = {
            http: 0,
            productionRelay: 0,
            websocket: 0,
        };

        await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (!['http:', 'https:'].includes(url.protocol) || allowedOrigins.has(url.origin)) {
                await route.continue();
                return;
            }

            blocked.http += 1;
            const productionRelay = isProductionRelay(url);
            if (productionRelay) blocked.productionRelay += 1;
            testInfo.annotations.push({
                type: 'idle-e2e-egress-blocked',
                description: productionRelay ? 'production-relay' : 'external-http-origin',
            });
            await route.abort('blockedbyclient');
        });

        await page.routeWebSocket('**/*', async (route) => {
            const url = new URL(route.url());
            if (allowedOrigins.has(comparableOrigin(url))) {
                route.connectToServer();
                return;
            }

            blocked.websocket += 1;
            const productionRelay = isProductionRelay(url);
            if (productionRelay) blocked.productionRelay += 1;
            testInfo.annotations.push({
                type: 'idle-e2e-egress-blocked',
                description: productionRelay ? 'production-relay' : 'external-websocket-origin',
            });
            await route.close({ code: 1008, reason: 'Idle E2E egress denied' });
        });

        await use();

        expect(
            blocked,
            'Browser E2E attempted network egress outside its explicit web and relay origins',
        ).toEqual({
            http: 0,
            productionRelay: 0,
            websocket: 0,
        });
    }, { auto: true }],
});

export { expect };
