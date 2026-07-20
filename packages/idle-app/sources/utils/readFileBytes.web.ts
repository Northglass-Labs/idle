/**
 * Read file bytes from a URI — web implementation.
 * Uses fetch() on blob: and data: URIs returned by expo-image-picker on web.
 */
import { readBoundedResponseBytes } from '@/sync/boundedJsonResponse';
import { streamingFetch } from '@/sync/streamingFetch';

const MAX_LOCAL_FILE_BYTES = 10 * 1024 * 1024;

export async function readFileBytes(uri: string): Promise<Uint8Array> {
    const response = await streamingFetch(uri);
    if (!response.ok) {
        throw new Error(`readFileBytes: fetch failed with status ${response.status}`);
    }
    return readBoundedResponseBytes(response, MAX_LOCAL_FILE_BYTES);
}
