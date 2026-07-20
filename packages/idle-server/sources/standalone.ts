import "reflect-metadata";

import * as fs from "fs";
import * as path from "path";
import { createPGlite } from "./storage/pgliteLoader";
import { parseInjectedHtmlConfig } from "./app/api/inlineConfig";
import { BootSecretEnvironment, consumeBootSecret, validateBootSecret } from "./utils/validateBootSecret";

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");

export async function runMigrations(opts: { pgliteDir: string; migrationsDir?: string } = { pgliteDir }) {
    const targetPgliteDir = opts.pgliteDir;
    console.log('Migrating database...');
    fs.mkdirSync(targetPgliteDir, { recursive: true });

    const pg = createPGlite(targetPgliteDir);

    // Create migrations tracking table
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" TEXT PRIMARY KEY,
            "migration_name" TEXT NOT NULL UNIQUE,
            "finished_at" TIMESTAMPTZ,
            "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
            "logs" TEXT
        );
    `);

    // Find migrations directory - explicit arg wins; fall back to defaults.
    let migrationsDirResolved = "";
    const candidates: string[] = [];
    if (opts.migrationsDir) candidates.push(opts.migrationsDir);
    candidates.push(
        path.join(process.cwd(), "prisma", "migrations"),
        path.join(process.cwd(), "packages", "idle-server", "prisma", "migrations"),
        path.join(path.dirname(process.execPath), "prisma", "migrations"),
    );
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            migrationsDirResolved = candidate;
            break;
        }
    }
    if (!migrationsDirResolved) {
        throw new Error(`Could not find prisma/migrations directory. Tried: ${candidates.join(", ")}`);
    }

    // Get all migration directories sorted
    const dirs = fs.readdirSync(migrationsDirResolved)
        .filter(d => fs.statSync(path.join(migrationsDirResolved, d)).isDirectory())
        .sort();

    // Get already applied migrations
    const applied = await pg.query<{ migration_name: string }>(
        `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
    );
    const appliedSet = new Set(applied.rows.map(r => r.migration_name));

    let appliedCount = 0;
    for (const dir of dirs) {
        if (appliedSet.has(dir)) {
            continue;
        }

        const sqlFile = path.join(migrationsDirResolved, dir, "migration.sql");
        if (!fs.existsSync(sqlFile)) {
            continue;
        }

        console.log('Applying database migration...');
        const sql = fs.readFileSync(sqlFile, "utf-8");

        try {
            await pg.exec(sql);
            await pg.query(
                `INSERT INTO "_prisma_migrations" ("id", "migration_name", "finished_at", "applied_steps_count") VALUES ($1, $2, now(), 1)`,
                [crypto.randomUUID(), dir]
            );
            appliedCount++;
        } catch (e: any) {
            throw new Error(`Failed to apply ${dir}: ${e.message}`);
        }
    }

    if (appliedCount === 0) {
        console.log("No new migrations to apply.");
    } else {
        console.log('Database migrations applied.');
    }

    await pg.close();
}

export function requireValidStandaloneSecret(value: string | undefined): string {
    const validation = validateBootSecret(value);
    if (!validation.ok) {
        throw new Error(validation.error);
    }
    return value!;
}

export function loadStandaloneSecret(environment: BootSecretEnvironment = process.env): string {
    return consumeBootSecret(environment);
}

async function serve(masterSecret: string) {
    // Ensure DB_PROVIDER is set for db.ts
    process.env.DB_PROVIDER = process.env.DB_PROVIDER || "pglite";
    process.env.PGLITE_DIR = process.env.PGLITE_DIR || pgliteDir;

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    // Bind loopback by default (matches api.ts). In production, a reverse proxy fronts
    // the relay on 127.0.0.1:3005, so a public bind only widens the attack
    // surface behind the firewall. Self-host without a fronting proxy opts in
    // with HOST=0.0.0.0. Keep the default on the smallest network boundary.
    const host = process.env.HOST || "127.0.0.1";
    const staticDir = findStaticDir();
    // The deprecated name is read-only compatibility for existing self-host scripts.
    const rawHtmlConfig = process.env.IDLE_INJECT_HTML_CONFIG ?? process.env.HAPPY_INJECT_HTML_CONFIG;
    const injectHtmlConfig = parseInjectedHtmlConfig(rawHtmlConfig);

    const { startServer } = await import("./index");
    await startServer({
        pgliteDir: process.env.PGLITE_DIR!,
        masterSecret,
        port,
        host,
        staticDir,
        injectHtmlConfig,
    });

    // Block until shutdown so the process stays alive.
    const { awaitShutdown } = await import("./utils/shutdown");
    await awaitShutdown();
    process.exit(0);
}

function findStaticDir(): string | undefined {
    const candidates = [
        process.env.IDLE_STATIC_DIR,
        // Read-only compatibility for existing self-host scripts.
        process.env.HAPPY_STATIC_DIR,
        path.join(process.cwd(), "webapp"),
        path.join(path.dirname(process.execPath), "webapp"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "index.html"))) {
            return candidate;
        }
    }

    return undefined;
}

// CLI — only when this file is invoked directly, not when imported as a library.
const standaloneEntrypoints = new Set([
    "standalone.ts",
    "standalone.js",
    "standalone.mjs",
    "standalone.cjs",
    "idle-server",
    "idle-server.cjs",
    "idle-server.exe",
]);

export function isStandaloneEntrypoint(invokedFile: string): boolean {
    // win32.basename splits on both "/" and "\", so a Windows-style argv[1] is
    // parsed correctly even on a POSIX host (and vice-versa). The POSIX basename
    // would leave backslashes intact and miss Windows entrypoints like
    // idle-server.exe when tests or tooling run cross-platform.
    return standaloneEntrypoints.has(path.win32.basename(invokedFile).toLowerCase());
}

function reportStandaloneFailure(_error: unknown): void {
    console.error('Standalone command failed. Check configuration and storage access.');
}

function loadStandaloneSecretOrExit(): string {
    try {
        return loadStandaloneSecret();
    } catch (error) {
        reportStandaloneFailure(error);
        process.exit(1);
    }
}

const invokedFile = process.argv[1] || "";
const isDirectInvocation = isStandaloneEntrypoint(invokedFile);

if (isDirectInvocation) {
    const command = process.argv[2];

    switch (command) {
        case "migrate":
            loadStandaloneSecretOrExit();
            runMigrations({ pgliteDir }).catch(e => {
                reportStandaloneFailure(e);
                process.exit(1);
            });
            break;
        case "serve":
            serve(loadStandaloneSecretOrExit()).catch(e => {
                reportStandaloneFailure(e);
                process.exit(1);
            });
            break;
        default:
            console.log(`idle-server - portable distribution

Usage:
  idle-server migrate    Apply database migrations
  idle-server serve      Start the server

Environment variables:
  DATA_DIR          Base data directory (default: ./data)
  PGLITE_DIR        PGlite database directory (default: DATA_DIR/pglite)
  DATABASE_URL      PostgreSQL URL (if set, uses external Postgres instead of PGlite)
  REDIS_URL         Redis URL (optional, not required for standalone)
  PORT              Server port (default: 3005)
  IDLE_MASTER_SECRET        Direct 64-character hexadecimal master secret
  IDLE_MASTER_SECRET_FILE   Absolute path to an owner-only file containing it

Configure exactly one master-secret source.
`);
            process.exit(command === "--help" || command === "-h" ? 0 : 1);
    }
}
