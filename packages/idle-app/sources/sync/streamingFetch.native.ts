import { fetch as expoFetch } from 'expo/fetch';

/**
 * Expo's native fetch exposes the response as a ReadableStream on iOS and
 * Android, allowing consumers to cancel as soon as an actual byte cap is hit.
 */
export const streamingFetch = expoFetch as unknown as typeof globalThis.fetch;
