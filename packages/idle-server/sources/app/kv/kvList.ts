import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";

export const MAX_KV_LIST_ITEMS = 100;
export const MAX_KV_LIST_RESPONSE_CHARS = 4 * 1024 * 1024;

export interface KVListOptions {
    prefix?: string;
    limit?: number;
}

export interface KVListResult {
    items: Array<{
        key: string;
        value: string;
        version: number;
    }>;
    truncated: boolean;
}

/**
 * List all key-value pairs for the authenticated user, optionally filtered by prefix.
 * Returns keys, values, and versions. Excludes entries with null values (deleted).
 */
export async function kvList(
    ctx: { uid: string },
    options?: KVListOptions
): Promise<KVListResult> {
    const where: any = {
        accountId: ctx.uid,
        value: {
            not: null  // Exclude deleted entries (null values)
        }
    };

    // Add prefix filter if specified
    if (options?.prefix) {
        where.key = {
            startsWith: options.prefix
        };
    }

    const requestedLimit = options?.limit ?? MAX_KV_LIST_ITEMS;
    const materializedLimit = Math.min(requestedLimit, MAX_KV_LIST_ITEMS);
    const results = await db.userKVStore.findMany({
        where,
        orderBy: {
            key: 'asc'
        },
        take: materializedLimit
    });

    const items: KVListResult['items'] = [];
    let responseChars = 0;
    let truncated = requestedLimit > materializedLimit && results.length === materializedLimit;
    for (const result of results) {
        if (result.value === null) continue;
        const value = privacyKit.encodeBase64(result.value);
        const approximateChars = result.key.length + value.length + 32;
        if (responseChars + approximateChars > MAX_KV_LIST_RESPONSE_CHARS) {
            truncated = true;
            break;
        }
        responseChars += approximateChars;
        items.push({
            key: result.key,
            value,
            version: result.version,
        });
    }

    return {
        items,
        truncated,
    };
}
