import assert from 'node:assert/strict';
import test from 'node:test';

import { findUnexpectedUpstreamMarkers } from '../packages/idle-app/scripts/web-export-upstream-boundary.mjs';

const text = (...codes) => String.fromCharCode(...codes);
const upstream = text(104, 97, 112, 112, 121);
const upstreamTitle = `${upstream[0].toUpperCase()}${upstream.slice(1)}`;
const retiredOrganization = text(115, 108, 111, 112, 117, 115);
const retiredServer = text(104, 97, 110, 100, 121, 45, 115, 101, 114, 118, 101, 114);

test('generated web artifacts allow only reviewed compatibility and icon-map uses', () => {
  const approvedFragments = [
    `X-${upstreamTitle}-Client`,
    `${upstream}Client`,
    `__${upstream.toUpperCase()}_CONFIG__`,
    `${upstreamTitle} EnCoder`,
    `${upstreamTitle} Blobs`,
    `(?:${upstream}|idle|sessions)`,
    `${upstream}:62000`,
    `"${upstream}-outline":62001`,
    `\\"${upstream}-sharp\\":62002`,
    `"emoticon-${upstream}":62003`,
    `robot-${upstream}-outline:62004`,
  ];

  assert.deepEqual(findUnexpectedUpstreamMarkers(approvedFragments.join(';')), []);
});

test('generated web artifacts reject upstream product branding and retired names', () => {
  const source = [
    `Welcome to ${upstreamTitle}`,
    `https://${retiredOrganization}.invalid`,
    `connect to ${retiredServer}`,
  ].join(';');

  assert.deepEqual(
    findUnexpectedUpstreamMarkers(source).map(finding => finding.index),
    [11, source.indexOf(retiredOrganization), source.indexOf(retiredServer)],
  );
});

test('lookalike properties do not broaden the generated artifact allowlist', () => {
  const source = [
    `${upstream}:not-a-codepoint`,
    `${upstream}-unexpected:62000`,
    `X-${upstreamTitle}-Client-Extra`,
    `${upstream}ClientTelemetry`,
  ].join(';');

  assert.equal(findUnexpectedUpstreamMarkers(source).length, 4);
});
