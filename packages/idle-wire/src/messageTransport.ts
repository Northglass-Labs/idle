export const MAX_MESSAGE_INGRESS_BODY_BYTES = 6 * 1024 * 1024;
export const MAX_MESSAGE_INGRESS_BATCH_ITEMS = 100;

const BODY_PREFIX_BYTES = new TextEncoder().encode('{"messages":[').byteLength;
const BODY_SUFFIX_BYTES = new TextEncoder().encode(']}').byteLength;
const ITEM_SEPARATOR_BYTES = 1;

/**
 * Split encrypted message uploads without relying on character counts. The
 * server enforces the same UTF-8 JSON body ceiling before parsing, so every
 * returned batch is safe to submit as `{ messages: batch }`.
 */
export function splitMessageIngressBatches<T>(
    messages: readonly T[],
    maxBodyBytes = MAX_MESSAGE_INGRESS_BODY_BYTES,
    maxItems = MAX_MESSAGE_INGRESS_BATCH_ITEMS,
): T[][] {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= BODY_PREFIX_BYTES + BODY_SUFFIX_BYTES) {
        throw new Error('Message ingress body limit is invalid');
    }
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
        throw new Error('Message ingress item limit is invalid');
    }

    const encoder = new TextEncoder();
    const batches: T[][] = [];
    let batch: T[] = [];
    let batchBytes = BODY_PREFIX_BYTES + BODY_SUFFIX_BYTES;

    for (const message of messages) {
        const messageBytes = encoder.encode(JSON.stringify(message)).byteLength;
        const standaloneBytes = BODY_PREFIX_BYTES + messageBytes + BODY_SUFFIX_BYTES;
        if (standaloneBytes > maxBodyBytes) {
            throw new Error('Message exceeds the ingress body limit');
        }

        const additionalBytes = messageBytes + (batch.length > 0 ? ITEM_SEPARATOR_BYTES : 0);
        if (batch.length >= maxItems || batchBytes + additionalBytes > maxBodyBytes) {
            batches.push(batch);
            batch = [];
            batchBytes = BODY_PREFIX_BYTES + BODY_SUFFIX_BYTES;
        }

        batch.push(message);
        batchBytes += messageBytes + (batch.length > 1 ? ITEM_SEPARATOR_BYTES : 0);
    }

    if (batch.length > 0) {
        batches.push(batch);
    }
    return batches;
}
