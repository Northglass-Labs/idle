# Deployment targets

Idle's relay is a stateful service: one Node.js process serves HTTP and
Socket.IO while PGlite stores data under `/data`. Every supported target uses
the root `Dockerfile`; the platform-specific files only describe how to run the
same image.

| Target | Server | Web app | Guide |
|---|---:|---:|---|
| Fly.io | Yes | No | [Fly.io](fly.md) |
| Railway | Yes | No | [Railway](railway.md) |
| Render | Yes | No | [Render](render.md) |
| Vercel | No | Yes | [Vercel web](vercel-web.md) |

For Docker, systemd, and tailnet deployments, see
[Self-hosting](../SELF-HOSTING.md). For a VPS exposed to the internet, also
apply the [self-hosted security baseline](security-hardening.md).

## Security and durability requirements

Before the first start:

1. Generate a unique 32-byte `IDLE_MASTER_SECRET`, save it in a password
   manager, and enter it only through the provider's secret store. Never commit
   it, bake it into an image, or paste it into logs or support requests.
2. Set `IDLE_AUTH_AUDIENCE` to the exact public HTTPS relay origin clients use.
   Authentication fails closed when this trusted audience is absent or differs.
3. Mount persistent storage at `/data`. Treat that volume and the master secret
   as one recovery set; losing either can make existing pairings unusable.
4. Terminate public traffic with HTTPS and expose only the relay's HTTP port.
   Keep database files, metrics, and admin interfaces private.
5. Verify `GET /health`, then pair a disposable client before relying on the
   deployment.
6. Configure backups and test a restore. Stop the relay or use a
   provider-consistent snapshot before copying live database files.

The workflows in this public repository build and test the server image; they
do not contain credentials or instructions for deploying Northglass-operated
infrastructure. Configure deployment automation in your own account or fork,
with an approval-protected environment.

Provider interfaces and pricing change. Check the provider's current
documentation before creating billable resources.
