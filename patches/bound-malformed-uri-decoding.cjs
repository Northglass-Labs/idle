// GHSA-vcc3-ghjq-m6fr recommends limiting input size when an upgrade is not
// compatible. Keep query-string's CommonJS decoder and bound only its slow
// malformed-input fallback. Valid percent-encoded URLs retain the native path.
const fs = require('node:fs');
const path = require('node:path');

const before = '\t\t// Fallback to a more advanced decoder\n\t\treturn customDecodeURIComponent(encodedURI);';
const after = '\t\t// Preserve oversized malformed input literally instead of recursive decoding.\n\t\tif (encodedURI.length > 256) return encodedURI;\n\t\treturn customDecodeURIComponent(encodedURI);';

function applyMalformedUriDecodingPatch({
  nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/idle-app/node_modules'),
  ],
  logger = console,
} = {}) {
  const changes = new Map();
  for (const root of nodeModulesRoots) {
    const packageRoot = path.join(root, 'decode-uri-component');
    if (!fs.existsSync(packageRoot)) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'decode-uri-component' || manifest.version !== '0.2.2') {
      throw new Error('Malformed URI guard requires decoder version 0.2.2');
    }
    const entry = path.join(packageRoot, 'index.js');
    if (!fs.lstatSync(entry).isFile()) throw new Error('Decoder entry must be a regular file');
    const source = fs.readFileSync(entry, 'utf8');
    if (source.split(after).length === 2 && !source.includes(before)) continue;
    if (source.split(before).length !== 2 || source.includes(after)) {
      throw new Error('Decoder entry no longer matches the reviewed malformed-input guard');
    }
    changes.set(fs.realpathSync(entry), source.replace(before, after));
  }
  for (const [entry, source] of changes) fs.writeFileSync(entry, source);
  if (changes.size > 0) logger.log(`[dependency-patch] bounded malformed URI decoding in ${changes.size} file(s)`);
  return { files: changes.size };
}

module.exports = { applyMalformedUriDecodingPatch };
if (require.main === module) applyMalformedUriDecodingPatch();
