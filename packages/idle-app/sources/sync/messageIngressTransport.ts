import { splitMessageIngressBatches } from '@northglass/idle-wire';

type PendingMessage = {
    localId: string;
    content: string;
};

export type MessageIngressTransportRecord = {
    localId: string;
    content: string;
};

/** Select the oldest safe batch and strip local-only retry metadata. */
export function selectNextMessageIngressBatch<T extends PendingMessage>(
    pending: readonly T[],
): MessageIngressTransportRecord[] {
    const transportMessages = pending.map((message) => ({
        localId: message.localId,
        content: message.content,
    }));
    return splitMessageIngressBatches(transportMessages)[0] ?? [];
}
