import { beforeEach, describe, expect, it } from 'vitest';
import { register } from 'prom-client';

import {
    recordRpcLookupRetries,
    recordRpcResult,
    rpcMetricMethod,
} from './rpcMetrics';

function labelsFor(metricName: string): Set<string> {
    const metric = register.getSingleMetric(metricName) as any;
    const values = metric?.hashMap ? Object.values(metric.hashMap) as Array<{ labels?: Record<string, string> }> : [];
    return new Set(values.map((value) => value.labels?.method).filter((value): value is string => Boolean(value)));
}

describe('RPC metric cardinality boundary', () => {
    beforeEach(() => {
        register.getSingleMetric('rpc_calls_total')?.reset();
        register.getSingleMetric('rpc_call_duration_seconds')?.reset();
        register.getSingleMetric('rpc_lookup_retries')?.reset();
    });

    it('normalizes every method to a finite server-owned vocabulary', () => {
        expect(rpcMetricMethod('session-1:bash')).toBe('bash');
        expect(rpcMetricMethod('machine-1:spawn-idle-session')).toBe('spawn-idle-session');
        expect(rpcMetricMethod('session-1:future-plugin-method')).toBe('other');
        expect(rpcMetricMethod(undefined)).toBe('invalid');
    });

    it('collapses thousands of attacker-selected method labels at every metric sink', () => {
        for (let index = 0; index < 10_000; index++) {
            const method = `scope-${index}:attacker${index}`;
            recordRpcResult(method, 'busy', 0.001);
            recordRpcLookupRetries(method, 7);
        }
        for (let index = 0; index < 100; index++) {
            recordRpcResult(`scope-${index}:bash`, 'success', 0.01);
            recordRpcLookupRetries(`scope-${index}:bash`, 0);
        }
        recordRpcResult(undefined, 'invalid_params', 0);

        expect(labelsFor('rpc_calls_total')).toEqual(new Set(['other', 'bash', 'invalid']));
        expect(labelsFor('rpc_call_duration_seconds')).toEqual(new Set(['other', 'bash', 'invalid']));
        expect(labelsFor('rpc_lookup_retries')).toEqual(new Set(['other', 'bash']));
    });
});
