import { Prisma } from "@prisma/client";
import { delay } from "@/utils/delay";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

export type Tx = Prisma.TransactionClient;

const symbol = Symbol();

export function afterTx(tx: Tx, callback: () => void | Promise<void>) {
    let callbacks = (tx as any)[symbol] as Array<() => void | Promise<void>>;
    callbacks.push(callback);
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as Array<() => void | Promise<void>>;
        return { result, callbacks };
    }
    while (true) {
        try {
            let result = await db.$transaction(wrapped, { isolationLevel: 'Serializable', timeout: 10000 });
            for (let callback of result.callbacks) {
                try {
                    // Post-commit callbacks run in registration order. Awaiting
                    // each callback keeps a rejected promise inside this
                    // containment boundary instead of escalating it to the
                    // process-level unhandled-rejection shutdown policy.
                    await callback();
                } catch (e) {
                    // The database transaction has already committed, so a
                    // notification failure cannot roll it back. Continue later
                    // callbacks and return the committed result, while keeping
                    // provider/database exception prose out of logs.
                    log({
                        module: 'inTx',
                        level: 'error',
                        failureType: e instanceof Error ? 'error' : typeof e,
                    }, 'Post-commit callback failed');
                }
            }
            return result.result;
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError) {
                if (e.code === 'P2034' && counter < 3) {
                    counter++;
                    await delay(counter * 100);
                    continue;
                }
            }
            throw e;
        }
    }
}
