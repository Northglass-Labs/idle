import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, delayMock, logMock } = vi.hoisted(() => ({
    dbMock: { $transaction: vi.fn() },
    delayMock: vi.fn(async () => undefined),
    logMock: vi.fn(),
}));

vi.mock('./db', () => ({ db: dbMock }));
vi.mock('../utils/delay', () => ({ delay: delayMock }));
vi.mock('../utils/log', () => ({ log: logMock }));

import { afterTx, inTx } from './inTx';

function serializationConflict() {
    return new Prisma.PrismaClientKnownRequestError('serialization conflict', {
        code: 'P2034',
        clientVersion: 'test',
    });
}

describe('serializable transaction retry boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('runs post-commit side effects once after a retried transaction commits', async () => {
        let attempts = 0;
        const sideEffect = vi.fn();
        dbMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
            attempts += 1;
            const result = await callback({});
            if (attempts < 3) throw serializationConflict();
            return result;
        });

        const result = await inTx(async (tx) => {
            afterTx(tx, sideEffect);
            return 'committed';
        });

        expect(result).toBe('committed');
        expect(attempts).toBe(3);
        expect(delayMock).toHaveBeenCalledTimes(2);
        expect(sideEffect).toHaveBeenCalledTimes(1);
        expect(dbMock.$transaction).toHaveBeenLastCalledWith(
            expect.any(Function),
            expect.objectContaining({ isolationLevel: 'Serializable' }),
        );
    });

    it('stops after three retries instead of looping indefinitely', async () => {
        let attempts = 0;
        dbMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
            attempts += 1;
            await callback({});
            throw serializationConflict();
        });

        await expect(inTx(async () => 'never-commits')).rejects.toMatchObject({ code: 'P2034' });

        expect(attempts).toBe(4);
        expect(delayMock).toHaveBeenCalledTimes(3);
    });

    it('awaits rejected async post-commit callbacks and continues in registration order', async () => {
        dbMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => (
            callback({})
        ));
        const callbackOrder: string[] = [];

        const result = await inTx(async (tx) => {
            afterTx(tx, async () => {
                callbackOrder.push('first-start');
                await Promise.resolve();
                callbackOrder.push('first-end');
                throw new Error('provider detail must stay contained');
            });
            afterTx(tx, async () => {
                callbackOrder.push('second');
            });
            return 'committed';
        });

        expect(result).toBe('committed');
        expect(callbackOrder).toEqual(['first-start', 'first-end', 'second']);
        expect(logMock).toHaveBeenCalledWith(
            expect.objectContaining({ module: 'inTx', level: 'error' }),
            'Post-commit callback failed',
        );
        expect(JSON.stringify(logMock.mock.calls)).not.toContain('provider detail must stay contained');
    });

    it('contains synchronous post-commit throws and continues later callbacks', async () => {
        dbMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => (
            callback({})
        ));
        const laterCallback = vi.fn();

        const result = await inTx(async (tx) => {
            afterTx(tx, () => {
                throw new Error('synchronous detail must stay contained');
            });
            afterTx(tx, laterCallback);
            return 'committed';
        });

        expect(result).toBe('committed');
        expect(laterCallback).toHaveBeenCalledOnce();
        expect(logMock).toHaveBeenCalledWith(
            expect.objectContaining({ module: 'inTx', level: 'error' }),
            'Post-commit callback failed',
        );
        expect(JSON.stringify(logMock.mock.calls)).not.toContain('synchronous detail must stay contained');
    });
});
