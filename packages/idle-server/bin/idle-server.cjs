#!/usr/bin/env node
'use strict';

const { pathToFileURL } = require('node:url');
const { resolveServerArtifact } = require('../index.cjs');

const artifact = resolveServerArtifact();
if (!artifact) {
  console.error('Could not locate the Idle server runtime. Reinstall @northglass/idle-server.');
  process.exit(1);
}

if (artifact.webappDir && !process.env.IDLE_STATIC_DIR) {
  process.env.IDLE_STATIC_DIR = artifact.webappDir;
}

// Load the runtime in this process so no long-lived launcher retains or
// forwards the boot environment after the runtime consumes it.
process.chdir(artifact.cwd);
import(pathToFileURL(artifact.entrypoint).href).catch(() => {
  console.error('Could not start the Idle server runtime. Reinstall @northglass/idle-server.');
  process.exit(1);
});
