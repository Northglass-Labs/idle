# Deploy the Idle relay to Fly.io

The committed `fly.toml` builds the root `Dockerfile`, routes HTTPS traffic to
port `3005`, mounts `idle_data` at `/data`, and checks `GET /health`. Its app
name and primary region are intentionally unset so a public checkout does not
encode an operator's topology.

## Deploy

1. Install `flyctl`, authenticate, and clone your fork.
2. Review `fly.toml`, especially its machine size, volume, and auto-stop
   behavior.
3. From the repository root, run:

   ```bash
   fly launch --no-deploy
   ```

   Choose a unique app name and a region appropriate for your users.
4. Generate a unique 32-byte `IDLE_MASTER_SECRET`. Save it in a password
   manager before entering it through Fly's secret interface. Do not place the
   value in `fly.toml` or a shell script. Fly documents both its vault behavior
   and stdin support in [Secrets and Fly Apps](https://fly.io/docs/apps/secrets/).
5. Set `IDLE_AUTH_AUDIENCE` to the exact app origin, for example
   `https://<your-app>.fly.dev`. This value is not a secret, but it is required
   before the relay starts.
6. Confirm that a volume named `idle_data` will be mounted at `/data`, then
   deploy:

   ```bash
   fly deploy
   ```

The `initial_size` in `fly.toml` is used when Fly creates the first volume.
Existing volumes are not resized by changing that field; see Fly's
[app configuration reference](https://fly.io/docs/reference/configuration/).

## Verify

```bash
fly status
fly volumes list
fly secrets list
curl --fail --silent --show-error https://<your-app>.fly.dev/health
```

`fly secrets list` shows names and digests, not plaintext values. Pair a
disposable Idle client, restart the Machine, and confirm the pairing survives;
that exercises both WebSocket routing and the `/data` mount.

## Operations notes

- Keep the master secret and volume backup together in your recovery plan.
- A volume is regional. Confirm the Machine and volume are colocated before
  changing regions.
- A single PGlite volume should be attached to one active relay process. Do not
  scale the service horizontally without moving to a database architecture that
  supports it.
- Review Fly's current pricing, machine, and volume documentation before
  provisioning resources.
