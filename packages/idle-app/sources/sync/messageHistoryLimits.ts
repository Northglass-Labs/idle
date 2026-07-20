import { z } from 'zod';
import { ApiMessageSchema, type ApiMessage } from './apiTypes';
import { getBase64DecodedByteLength } from '@northglass/idle-wire';
import {
    estimateApproximateBytes,
    MAX_RETAINED_SESSION_MESSAGE_BYTES,
    MAX_STORED_SESSION_MESSAGES,
} from './sessionMessageLimits';

export { MAX_STORED_SESSION_MESSAGES } from './sessionMessageLimits';

export const MESSAGE_HISTORY_PAGE_SIZE = 25;
export const MAX_FORWARD_HISTORY_PAGES = 5;
export const MAX_MESSAGE_PAGE_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGE_RESPONSE_BODY_BYTES = 20 * 1024 * 1024;

export type BoundedMessagePage = {
    messages: ApiMessage[];
    hasMore: boolean;
};

const BoundedMessagePageEnvelopeSchema = z.object({
    messages: z.array(z.unknown()).max(MESSAGE_HISTORY_PAGE_SIZE),
    hasMore: z.boolean(),
}).strict();

export function parseBoundedMessagePage(value: unknown): BoundedMessagePage | null {
    const envelope = BoundedMessagePageEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
        return null;
    }

    const messages: ApiMessage[] = [];
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    const seenLocalIds = new Set<string>();
    let ciphertextBytes = 0;
    for (const item of envelope.data.messages) {
        const parsed = ApiMessageSchema.safeParse(item);
        if (!parsed.success || !Number.isSafeInteger(parsed.data.seq) || parsed.data.seq < 1) {
            return null;
        }
        if (
            seenIds.has(parsed.data.id)
            || seenSeqs.has(parsed.data.seq)
            || (parsed.data.localId != null && seenLocalIds.has(parsed.data.localId))
        ) {
            return null;
        }
        seenIds.add(parsed.data.id);
        seenSeqs.add(parsed.data.seq);
        if (parsed.data.localId != null) seenLocalIds.add(parsed.data.localId);
        const decodedBytes = parsed.data.content.t === 'encrypted'
            ? getBase64DecodedByteLength(parsed.data.content.c)
            : 0;
        if (decodedBytes === null) {
            return null;
        }
        ciphertextBytes += decodedBytes;
        if (ciphertextBytes > MAX_MESSAGE_PAGE_CIPHERTEXT_BYTES) {
            return null;
        }
        messages.push(parsed.data);
    }

    return { messages, hasMore: envelope.data.hasMore };
}

type MessageTreeNode<T> = T & { children?: T[] };
type RetentionBudget = { remainingNodes: number; remainingBytes: number };
const MESSAGE_TREE_LINK_OVERHEAD_BYTES = 64;

function estimateMessageNodeBytes<T extends { id: string; createdAt: number }>(
    message: T,
    byteLimit: number,
): number {
    const { children: _children, ...messageWithoutChildren } = message as MessageTreeNode<T>;
    const estimated = estimateApproximateBytes(messageWithoutChildren, byteLimit);
    if (estimated > byteLimit || estimated + MESSAGE_TREE_LINK_OVERHEAD_BYTES > byteLimit) {
        return byteLimit + 1;
    }
    return estimated + MESSAGE_TREE_LINK_OVERHEAD_BYTES;
}

function retainChildrenWithinBudget<T extends { id: string; createdAt: number }>(
    message: T,
    budget: RetentionBudget,
): T {
    const children = (message as MessageTreeNode<T>).children;
    if (!Array.isArray(children)) {
        return message;
    }
    if (budget.remainingNodes <= 0 || budget.remainingBytes <= 0) {
        return { ...message, children: [] } as T;
    }

    const newestChildren: T[] = [];
    for (const child of [...children].sort((left, right) => right.createdAt - left.createdAt)) {
        if (budget.remainingNodes <= 0 || budget.remainingBytes <= 0) break;
        const childBytes = estimateMessageNodeBytes(child, budget.remainingBytes);
        if (childBytes > budget.remainingBytes) continue;
        newestChildren.push(child);
        budget.remainingNodes -= 1;
        budget.remainingBytes -= childBytes;
    }
    const retainedIds = new Set(newestChildren.map((child) => child.id));
    const retainedChildren = children.filter((child) => retainedIds.has(child.id));

    return {
        ...message,
        children: retainedChildren.map((child) => retainChildrenWithinBudget(child, budget)),
    } as T;
}

export function estimateRetainedSessionMessagesBytes(messages: readonly unknown[]): number {
    return estimateApproximateBytes(messages, MAX_RETAINED_SESSION_MESSAGE_BYTES);
}

export function filterRetainedSessionMessages<T extends { id: string; createdAt: number }>(
    messages: readonly T[],
    retainedIds: ReadonlySet<string>,
): { messages: T[]; messagesMap: Record<string, T> } {
    const filterTree = (message: T): T | null => {
        if (!retainedIds.has(message.id)) return null;
        const children = (message as MessageTreeNode<T>).children;
        if (!Array.isArray(children)) return message;
        const retainedChildren = children
            .map(filterTree)
            .filter((child): child is T => child !== null);
        return { ...message, children: retainedChildren } as T;
    };

    const retainedMessages = messages
        .map(filterTree)
        .filter((message): message is T => message !== null);
    return {
        messages: retainedMessages,
        messagesMap: Object.fromEntries(retainedMessages.map((message) => [message.id, message])),
    };
}

export function retainRecentSessionMessages<T extends { id: string; createdAt: number }>(
    messagesMap: Record<string, T>,
): { messages: T[]; messagesMap: Record<string, T> } {
    const rootCandidates = Object.values(messagesMap)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, MAX_STORED_SESSION_MESSAGES);
    const roots: T[] = [];
    let remainingBytes = MAX_RETAINED_SESSION_MESSAGE_BYTES - 32;
    for (const root of rootCandidates) {
        const rootBytes = estimateMessageNodeBytes(root, remainingBytes);
        if (rootBytes > remainingBytes) continue;
        roots.push(root);
        remainingBytes -= rootBytes;
    }
    const budget: RetentionBudget = {
        remainingNodes: MAX_STORED_SESSION_MESSAGES - roots.length,
        remainingBytes,
    };
    const messages = roots.map((message) => retainChildrenWithinBudget(message, budget));

    return {
        messages,
        messagesMap: Object.fromEntries(messages.map((message) => [message.id, message])),
    };
}
