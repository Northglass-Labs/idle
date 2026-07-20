import { describe, expect, it } from 'vitest';
import { versionRoutes } from './versionRoutes';

type VersionRequest = {
    body: {
        platform: string;
        version: string;
        app_id: string;
    };
};

type VersionReply = {
    send(payload: { updateUrl: string | null }): void;
};

type VersionHandler = (request: VersionRequest, reply: VersionReply) => Promise<void>;

function registeredVersionHandler(): VersionHandler {
    let handler: VersionHandler | undefined;
    const app = {
        post(
            path: string,
            _options: unknown,
            registered: VersionHandler,
        ) {
            expect(path).toBe('/v1/version');
            handler = registered;
        },
    };

    versionRoutes(app as unknown as Parameters<typeof versionRoutes>[0]);
    expect(handler).toBeDefined();
    return handler!;
}

async function requestUpdateUrl(platform: string, version: string, appId: string) {
    const handler = registeredVersionHandler();
    let response: { updateUrl: string | null } | undefined;

    await handler(
        {
            body: {
                platform,
                version,
                app_id: appId,
            },
        },
        {
            send(payload) {
                response = payload;
            },
        },
    );

    return response;
}

describe('versionRoutes', () => {
    it('does not force App Store updates while Idle is distributed through TestFlight', async () => {
        await expect(
            requestUpdateUrl('ios', '0.4.20', 'com.northglass.idle'),
        ).resolves.toEqual({ updateUrl: null });
        await expect(
            requestUpdateUrl('ios', '0.1.0', 'com.northglass.idle'),
        ).resolves.toEqual({ updateUrl: null });
    });

    it('does not advertise an unpublished Play Store listing', async () => {
        await expect(
            requestUpdateUrl('android', '0.4.20', 'com.northglass.idle'),
        ).resolves.toEqual({ updateUrl: null });
        await expect(
            requestUpdateUrl('android', '0.1.0', 'com.northglass.idle'),
        ).resolves.toEqual({ updateUrl: null });
    });

    it('fails closed for unknown native clients', async () => {
        await expect(
            requestUpdateUrl('ios', '0.1.0', 'com.example.client'),
        ).resolves.toEqual({ updateUrl: null });
        await expect(
            requestUpdateUrl('desktop', '0.1.0', 'com.northglass.idle'),
        ).resolves.toEqual({ updateUrl: null });
    });
});
