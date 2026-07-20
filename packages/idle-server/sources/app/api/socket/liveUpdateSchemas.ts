import { z } from 'zod';
import {
    MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS,
    MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS,
    MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS,
    MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS,
} from '@northglass/idle-wire';

// Prisma maps these counters to PostgreSQL INTEGER. Leave one increment of
// headroom so a valid optimistic write cannot overflow its persisted column.
export const MAX_EXPECTED_PERSISTED_VERSION = 2_147_483_646;

// JavaScript Date's inclusive upper bound (9999-12-31T23:59:59.000Z).
// Keep live timestamps within the range every downstream Date consumer can
// represent without throwing or persisting an invalid value.
export const MAX_EPOCH_MILLISECONDS = 253_402_300_799_000;

const SocketTargetIdSchema = z.string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/);

const ExpectedVersionSchema = z.number()
    .int()
    .nonnegative()
    .max(MAX_EXPECTED_PERSISTED_VERSION);

const EpochMillisecondsSchema = z.number()
    .int()
    .nonnegative()
    .max(MAX_EPOCH_MILLISECONDS);

export const MachineAliveDataSchema = z.object({
    machineId: SocketTargetIdSchema,
    time: EpochMillisecondsSchema,
}).strict();

export const MachineMetadataUpdateDataSchema = z.object({
    machineId: SocketTargetIdSchema,
    metadata: z.string().max(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS),
    expectedVersion: ExpectedVersionSchema,
}).strict();

export const MachineStateUpdateDataSchema = z.object({
    machineId: SocketTargetIdSchema,
    daemonState: z.string().max(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS),
    expectedVersion: ExpectedVersionSchema,
}).strict();

export const SessionAliveDataSchema = z.object({
    sid: SocketTargetIdSchema,
    time: EpochMillisecondsSchema,
    thinking: z.boolean().optional(),
}).strict();

export const SessionEndDataSchema = z.object({
    sid: SocketTargetIdSchema,
    time: EpochMillisecondsSchema,
}).strict();

export const SessionMetadataUpdateDataSchema = z.object({
    sid: SocketTargetIdSchema,
    metadata: z.string().max(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS),
    expectedVersion: ExpectedVersionSchema,
}).strict();

export const SessionStateUpdateDataSchema = z.object({
    sid: SocketTargetIdSchema,
    agentState: z.string().max(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS).nullable(),
    expectedVersion: ExpectedVersionSchema,
}).strict();
