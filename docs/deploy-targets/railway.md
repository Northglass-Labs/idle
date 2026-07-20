# Deploy the Idle relay to Railway

Railway can build the root `Dockerfile` from a GitHub fork. The committed
`railway.json` selects that Dockerfile, configures `GET /health`, and uses a
bounded restart policy. A persistent volume and the relay secret are still
operator-owned settings.

## Deploy from a fork

1. Fork the repository and review the Dockerfile and `railway.json`.
2. In Railway, create a project from that fork.
3. Add `IDLE_MASTER_SECRET` as a sealed service variable. Generate a unique
   32-byte value and save it in a password manager before entering it. Never use
   a repository variable or build argument for this secret.
4. Add `IDLE_AUTH_AUDIENCE` as the exact public HTTPS service origin clients
   will use, without a path, query, or fragment.
5. Add a persistent volume mounted at `/data`.
6. Deploy and create a public HTTPS domain for the service. Update the audience
   before changing that domain.

Railway detects a root-level `Dockerfile`; see its
[Dockerfile documentation](https://docs.railway.com/builds/dockerfiles). The
platform injects `PORT`, and `railway.json` tells it to poll `/health` while a
new deployment starts.

## Verify

```bash
curl --fail --silent --show-error https://<your-service>.railway.app/health
```

Then pair a disposable Idle client, redeploy the same revision, and confirm the
pairing survives. If it does not, verify the volume is mounted at `/data` before
creating any important sessions.

Railway notes that services with attached volumes cannot keep two deployments
mounted simultaneously, so a deployment can have brief downtime even with a
health check. See [Railway health checks](https://docs.railway.com/deployments/healthchecks).

## Operations notes

- Limit GitHub installation access to the fork or organization that owns the
  deployment.
- Require successful CI checks before enabling automatic deploys.
- Keep the master secret out of Docker build arguments; build-time values can
  become image metadata or layers.
- Back up `/data` and the master secret as one recovery set.
- Review current resource limits and pricing in Railway before provisioning.
