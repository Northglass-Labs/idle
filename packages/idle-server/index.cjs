'use strict';

const fs = require('node:fs');
const path = require('node:path');

function packageRoot() {
  return __dirname;
}

function getWebappDirectory() {
  return path.join(packageRoot(), 'webapp');
}

function resolveServerArtifact() {
  const runtime = path.join(packageRoot(), 'dist', 'standalone.mjs');
  if (fs.existsSync(runtime)) {
    const webappDir = getWebappDirectory();
    return {
      command: process.execPath,
      prefixArgs: [runtime],
      entrypoint: runtime,
      cwd: packageRoot(),
      source: 'package',
      webappDir: fs.existsSync(path.join(webappDir, 'index.html')) ? webappDir : undefined,
    };
  }

  return undefined;
}

module.exports = {
  packageRoot,
  getWebappDirectory,
  resolveServerArtifact,
};
