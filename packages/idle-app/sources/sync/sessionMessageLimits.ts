export const MAX_STORED_SESSION_MESSAGES = 500;
export const MAX_RETAINED_SESSION_MESSAGE_BYTES = 32 * 1024 * 1024;

const MAX_APPROXIMATE_SIZE_WORK_ITEMS = 100_000;
const OBJECT_OVERHEAD_BYTES = 32;
const COLLECTION_ENTRY_OVERHEAD_BYTES = 16;

/**
 * Conservative, short-circuiting retained-size estimate. It never serializes
 * payloads and bounds both its worklist and visited-object set; exhausting
 * either budget is treated as oversized.
 */
export function estimateApproximateBytes(
    value: unknown,
    byteLimit = MAX_RETAINED_SESSION_MESSAGE_BYTES,
): number {
    const stack: unknown[] = [value];
    const seen = new WeakSet<object>();
    let bytes = 0;
    let workItems = 0;

    const addWorkItem = (item: unknown): boolean => {
        if (stack.length >= MAX_APPROXIMATE_SIZE_WORK_ITEMS) return false;
        stack.push(item);
        return true;
    };

    while (stack.length > 0) {
        workItems += 1;
        if (workItems > MAX_APPROXIMATE_SIZE_WORK_ITEMS) return byteLimit + 1;
        const item = stack.pop();

        if (item === null || item === undefined) {
            bytes += 4;
        } else if (typeof item === 'string') {
            bytes += 8 + item.length * 2;
        } else if (typeof item === 'number' || typeof item === 'bigint') {
            bytes += 8;
        } else if (typeof item === 'boolean') {
            bytes += 4;
        } else if (typeof item === 'symbol' || typeof item === 'function') {
            bytes += 16;
        } else if (typeof item === 'object') {
            if (seen.has(item)) continue;
            seen.add(item);
            bytes += OBJECT_OVERHEAD_BYTES;

            if (ArrayBuffer.isView(item)) {
                bytes += item.byteLength;
            } else if (item instanceof ArrayBuffer) {
                bytes += item.byteLength;
            } else if (item instanceof Date) {
                bytes += 8;
            } else if (item instanceof Map) {
                bytes += item.size * COLLECTION_ENTRY_OVERHEAD_BYTES;
                for (const [key, entryValue] of item) {
                    if (!addWorkItem(key) || !addWorkItem(entryValue)) return byteLimit + 1;
                }
            } else if (item instanceof Set) {
                bytes += item.size * COLLECTION_ENTRY_OVERHEAD_BYTES;
                for (const entry of item) {
                    if (!addWorkItem(entry)) return byteLimit + 1;
                }
            } else if (Array.isArray(item)) {
                bytes += item.length * 8;
                for (const entry of item) {
                    if (!addWorkItem(entry)) return byteLimit + 1;
                }
            } else {
                const record = item as Record<string, unknown>;
                for (const key in record) {
                    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
                    bytes += 8 + key.length * 2;
                    if (!addWorkItem(record[key])) return byteLimit + 1;
                }
            }
        }

        if (bytes > byteLimit) return byteLimit + 1;
    }

    return bytes;
}
