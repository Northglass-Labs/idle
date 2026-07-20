# Deploy the Idle relay to Render

The root `render.yaml` is a Render Blueprint for the relay image and its
persistent disk. Review the file in your fork before importing it; a Blueprint
is infrastructure configuration and can create billable resources.

## Deploy from the Blueprint

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Northglass-Labs/idle)

1. Import the Blueprint from your fork rather than granting a third party
   access to unrelated repositories.
2. Generate a unique 32-byte `IDLE_MASTER_SECRET`, save it in a password
   manager, and enter it when Render prompts for the `sync: false` variable.
3. Enter the exact planned public HTTPS service origin for
   `IDLE_AUTH_AUDIENCE`, with no path, query, or fragment.
4. Confirm the persistent disk is mounted at `/data`.
5. Review the selected plan, region, and automatic-deploy setting before
   approving creation.
6. After assigning a custom HTTPS domain, update `IDLE_AUTH_AUDIENCE` to that
   exact origin before clients switch to it.

Render's Blueprint reference documents that `sync: false` prompts for a secret
during initial creation and that the value must be added manually to an existing
service. It also documents persistent disk fields. See the
[Blueprint YAML reference](https://render.com/docs/blueprint-spec).

## Verify

```bash
curl --fail --silent --show-error https://<your-service>.onrender.com/health
```

Pair a disposable client, restart or redeploy the service, and confirm the
pairing survives. A successful health check alone does not prove that `/data`
is persistent.

## Operations notes

- Do not put secrets in Docker build arguments. Render makes configured values
  available to Docker builds, so keep sensitive configuration runtime-only.
- A service with an attached PGlite disk should remain single-instance.
- Consider requiring checks to pass before automatic deployment. Render's
  current Blueprint schema supports `autoDeployTrigger: checksPass`.
- Back up the disk and master secret as one recovery set.
- Review Render's current disk availability, plans, regions, and pricing before
  provisioning.
