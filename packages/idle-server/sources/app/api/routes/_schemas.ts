/**
 * Shared, length-bounded Zod string schemas for API route validation.
 *
 * Fastify's default body-size limit (1MB) only catches gross payloads — it
 * does not constrain individual fields. A bare `z.string()` lets an attacker
 * spend memory + parse cost on a single 500KB field that we then store,
 * index, or log. These named schemas put a sensible upper bound on each
 * semantic kind of input so every route inherits the same defense.
 *
 * Picking a cap: the rule is "as small as production reality allows."
 * - For format-constrained fields (cuid IDs, base64 keys), the cap is just
 *   above the real wire size.
 * - For encrypted blobs we have to be generous (variable JSON ciphertext),
 *   but never unlimited.
 * - Fields without a named schema require an explicit route-local cap and a
 *   comment documenting the downstream format or storage invariant.
 *
 * If a route ever needs to RELAX a cap (real production payload exceeds it),
 * raise the cap here rather than reverting to bare `z.string()` — the named
 * schema becomes the single place to look when the limit needs to move.
 */

import { z } from "zod";
import { EncryptedMessageCiphertextSchema } from '@northglass/idle-wire';

// IDs (cuid/uuid format) — short, opaque identifiers. Real values are
// 25-36 chars; 64 leaves room for variant formats without ever inviting
// pathological inputs.
export const IdSchema = z.string().min(1).max(64);

// Client-allocated UUIDs that can become filesystem or durable identity
// components use one canonical spelling. UUID parsers commonly accept both
// cases even though case-insensitive storage treats them as the same name.
export const CanonicalUuidSchema = z.string().uuid().refine(
    (value) => value === value.toLowerCase(),
    { message: 'UUID must use canonical lowercase spelling' },
);

// Tags, keys, short identifiers — session tags, KV keys, vendor names,
// query prefixes. Bounded enough to keep DB index lookups cheap.
export const TagSchema = z.string().min(1).max(128);

// Names, titles, usernames, short human-entered text fields. Allows empty
// for fields that are intentionally optional human input.
export const NameSchema = z.string().min(0).max(256);

// URLs, redirect URIs, OAuth callback URLs, file paths. 2KB is the
// practical maximum a well-behaved client should send.
export const UrlSchema = z.string().min(1).max(2048);

// Tokens, signatures (base64-encoded crypto material), API tokens, push
// tokens. Real values are 100-512 chars; 1KB leaves headroom for future
// algorithm variants without uncapping the field.
export const TokenSchema = z.string().min(1).max(1024);

// Encrypted blobs — base64-encoded ciphertext for body / artifact /
// access-key payloads. Variable size driven by user content; 64KB covers
// realistic encrypted JSON payloads while still bounding memory cost.
export const EncryptedBlobSchema = z.string().min(1).max(65536);

// Encrypted message content — coding-agent turns can contain bounded tool
// output such as file reads, search results, and protocol responses. The
// shared wire schema permits up to 4 MiB of decoded ciphertext, including its
// standard-base64 expansion, while rejecting malformed encoding. Fastify's
// route bodyLimit independently caps the complete request batch.
export const EncryptedMessageContentSchema = EncryptedMessageCiphertextSchema;

// Encrypted metadata payloads — small encrypted JSON describing a
// machine, session, or artifact header. 16KB is well above observed
// production values without inviting megabyte-scale abuse.
export const EncryptedMetadataSchema = z.string().min(0).max(16384);

// Free-form text — most generous of the bounded options. Reserved for
// log messages and human-entered descriptions where the schema can't
// constrain shape but still needs an upper bound.
export const FreeTextSchema = z.string().max(8192);

// Email addresses. RFC 5321 caps a path at 256 chars; we mirror that and
// add format validation so the schema rejects bare strings up front.
export const EmailSchema = z.string().email().max(256);
