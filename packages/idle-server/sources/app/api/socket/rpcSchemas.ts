/**
 * Zod schemas for WebSocket RPC envelopes.
 *
 * Before schema validation these arrived as `data: any` in rpcHandler.ts — meaning a
 * client could send `{ method: 12345 }` or `{ method: null }` and we'd
 * silently fall through the `typeof` guards without catching the malformed
 * envelope structurally. We also could not see the full envelope shape
 * documented anywhere.
 *
 * The schemas here validate the envelope, scoped method grammar, and encrypted
 * ciphertext size. The relay cannot validate method-specific plaintext because
 * only the target owns the content key.
 */

import { z } from "zod";
const MAX_RPC_CIPHERTEXT_CHARS = 16 * 1024 * 1024;
const RpcMethodSchema = z.string()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const RpcCiphertextSchema = z.string().min(1).max(MAX_RPC_CIPHERTEXT_CHARS);

export const RpcRegisterDataSchema = z.object({
    method: RpcMethodSchema,
}).strict();
export type RpcRegisterData = z.infer<typeof RpcRegisterDataSchema>;

export const RpcUnregisterDataSchema = z.object({
    method: RpcMethodSchema,
}).strict();
export type RpcUnregisterData = z.infer<typeof RpcUnregisterDataSchema>;

export const RpcCallDataSchema = z.object({
    method: RpcMethodSchema,
    params: RpcCiphertextSchema,
}).strict();
export type RpcCallData = z.infer<typeof RpcCallDataSchema>;
