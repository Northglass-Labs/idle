# Monitoring and troubleshooting

This guide covers the supported, provider-neutral monitoring surface for a
self-hosted Idle server. Keep health and metrics endpoints private unless your
own authenticated monitoring boundary protects them.

## Health endpoints

The main API exposes:

```text
GET /health
```

The packaged server listens on port 3005 by default. A healthy response confirms
the service can reach its database. Configure your reverse proxy or container
health check against the loopback/private address rather than exposing a new
public route solely for monitoring.

## Prometheus metrics

The optional metrics listener exposes:

```text
GET /health
GET /metrics
```

It binds to `127.0.0.1:9090` by default. Set `METRICS_ENABLED=false` to
disable it, `METRICS_PORT` to choose another port, or `METRICS_HOST` only
when a private sidecar or monitoring network requires a different bind address.
Binding metrics to all interfaces can reveal operational counts and client
metadata; do so only behind an access-controlled network boundary.

The exported Prometheus series cover request counts and duration, active
WebSocket connections, event/heartbeat counts, cache activity, approximate
database record counts, and stream lag. Labels are operational metadata, not
session content.

## Logs

The server writes structured, redacted logs to standard output. Use the logging
and retention controls provided by your process manager or container platform.
Do not enable request-body logging at a reverse proxy: requests can contain
authentication material and encrypted user data.

Idle's logger redacts sensitive field names, bearer credentials, common token
formats, email addresses, URLs, identifiers, and filesystem paths. Redaction is
defense in depth, not permission to log secrets. New code should log fixed error
codes and bounded operational context instead of raw requests, exceptions, or
user-provided strings.

Production output is newline-delimited JSON; colored pretty output is reserved
for local development and tests. Each completed HTTP request emits one bounded
event containing only the HTTP method, the registered route template, status
code, and a coarse duration bucket. Raw URLs and query strings, host and peer
addresses, request identifiers, headers, and request or response bodies are not
part of that event. Process IDs and server hostnames are left to the process
manager instead of being duplicated in application output. An unmatched or
malformed route is recorded as `unmatched` instead of copying caller-controlled
input into the journal.

## Basic checks

```sh
# Main API and database readiness
curl --fail --silent http://127.0.0.1:3005/health

# Optional metrics listener
curl --fail --silent http://127.0.0.1:9090/health
```

If the API health check fails, inspect the current process/container logs,
confirm the configured database is reachable, and verify the server was given a
valid master secret. If only metrics fails, confirm that metrics are enabled and
that the configured metrics port is not already occupied.

For Internet-facing deployments, terminate TLS at a maintained reverse proxy,
publish only the main API, and keep the database, metrics listener, and
administrative interfaces on private networks.
