import { Counter, Histogram, register } from 'prom-client';

export const CORE_RPC_METRIC_METHODS = [
    'abort',
    'bash',
    'claude-duplicate-session',
    'claude-fork-session',
    'claude-list-rewind-points',
    'codex-duplicate-thread',
    'codex-fork-thread',
    'codex-list-rewind-points',
    'gitDiff',
    'goal-action',
    'killSession',
    'openclaw-retry-pairing',
    'permission',
    'readFile',
    'resume-idle-session',
    'ripgrep',
    'spawn-idle-session',
    'stop-daemon',
    'stop-session',
    'switch',
    'writeFile',
] as const;

type CoreRpcMetricMethod = typeof CORE_RPC_METRIC_METHODS[number];
export type RpcMetricMethod = CoreRpcMetricMethod | 'other' | 'invalid';
export type RpcMetricResult =
    | 'ambiguous_target'
    | 'busy'
    | 'internal_error'
    | 'invalid_params'
    | 'invalid_result'
    | 'not_available'
    | 'request_failed'
    | 'self_call'
    | 'success'
    | 'target_disconnected'
    | 'unauthorized_caller';

const knownMethods: ReadonlySet<string> = new Set(CORE_RPC_METRIC_METHODS);
const knownResults: ReadonlySet<string> = new Set<RpcMetricResult>([
    'ambiguous_target',
    'busy',
    'internal_error',
    'invalid_params',
    'invalid_result',
    'not_available',
    'request_failed',
    'self_call',
    'success',
    'target_disconnected',
    'unauthorized_caller',
]);

const rpcCallCounter = new Counter({
    name: 'rpc_calls_total',
    help: 'Total RPC calls by bounded method family and outcome',
    labelNames: ['method', 'result'] as const,
    registers: [register],
});

const rpcCallDuration = new Histogram({
    name: 'rpc_call_duration_seconds',
    help: 'RPC call duration from receipt to response',
    labelNames: ['method', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
    registers: [register],
});

const rpcLookupRetries = new Histogram({
    name: 'rpc_lookup_retries',
    help: 'Number of grace-window polls before finding daemon (0 = instant)',
    labelNames: ['method'] as const,
    buckets: [0, 1, 2, 3, 4, 5, 6, 7],
    registers: [register],
});

export function rpcMetricMethod(prefixedMethod: string | undefined): RpcMetricMethod {
    if (!prefixedMethod) return 'invalid';
    const separator = prefixedMethod.lastIndexOf(':');
    const base = separator >= 0 ? prefixedMethod.slice(separator + 1) : prefixedMethod;
    return knownMethods.has(base) ? base as CoreRpcMetricMethod : 'other';
}

function rpcMetricResult(result: unknown): RpcMetricResult {
    return typeof result === 'string' && knownResults.has(result)
        ? result as RpcMetricResult
        : 'internal_error';
}

export function recordRpcResult(
    method: string | undefined,
    result: RpcMetricResult,
    durationSeconds: number,
): void {
    const labels = {
        method: rpcMetricMethod(method),
        result: rpcMetricResult(result),
    };
    rpcCallCounter.inc(labels);
    rpcCallDuration.observe(labels, Math.max(0, durationSeconds));
}

export function recordRpcLookupRetries(method: string | undefined, polls: number): void {
    rpcLookupRetries.observe({ method: rpcMetricMethod(method) }, Math.max(0, polls));
}
