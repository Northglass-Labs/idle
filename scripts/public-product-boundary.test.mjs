import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

function filesBelow(relativePath) {
  const base = join(root, relativePath)
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(relative(root, absolute))
    }
  }
  visit(base)
  return files
}

test('public workspace contains only supported product packages', () => {
  const rootPackage = readJson('package.json')

  assert.equal(existsSync(join(root, 'packages/codium')), false)
  assert.equal(existsSync(join(root, 'packages/idle-app/src-tauri')), false)
  assert.equal(rootPackage.scripts?.codium, undefined)
  assert.equal(rootPackage.workspaces.packages.includes('packages/codium'), false)
  assert.doesNotMatch(read('yarn.lock'), /@openai\/codex(?:@|-darwin-|-linux-|-win32-)/)
})

test('Expo app has no desktop-prototype scripts or dependencies', () => {
  const appPackage = readJson('packages/idle-app/package.json')

  assert.deepEqual(
    Object.keys(appPackage.scripts).filter((name) => name.startsWith('tauri:')),
    [],
  )
  assert.deepEqual(
    Object.keys(appPackage.dependencies).filter((name) => name.startsWith('@tauri-apps/')),
    [],
  )
  assert.doesNotMatch(read('yarn.lock'), /@tauri-apps\//)
})

test('mobile and web source no longer carry Tauri runtime branches', () => {
  const sourceFiles = filesBelow('packages/idle-app/sources').filter((path) =>
    /\.(?:ts|tsx|js|jsx)$/.test(path),
  )
  const prototypeNames = sourceFiles.filter((path) => /tauri/i.test(path))
  const prototypeReferences = sourceFiles.filter((path) =>
    /(?:@tauri-apps|__TAURI(?:_INTERNALS__)?|\bisTauri\b|\buseTauri)/.test(read(path)),
  )

  assert.deepEqual(prototypeNames, [])
  assert.deepEqual(prototypeReferences, [])
  assert.doesNotMatch(read('packages/idle-app/metro.config.js'), /src-tauri/)
})

test('public docs and upstream inventory do not retain prototype references', () => {
  const docsWithTauri = filesBelow('docs')
    .filter((path) => /\.(?:md|mdx|txt)$/.test(path))
    .filter((path) => /\bTauri\b|tauri:|src-tauri/.test(read(path)))

  assert.deepEqual(docsWithTauri, [])
  assert.doesNotMatch(read('.upstream-cruft-allow.txt'), /^packages\/codium\//m)
})

test('obsolete public marketing binaries cannot reintroduce stale branding or claims', () => {
  assert.equal(existsSync(join(root, '.github/header.png')), false)
  assert.equal(existsSync(join(root, '.github/brand/github-social-card.png')), false)
  assert.doesNotMatch(read('README.md'), /\.github\/header\.png/)
})

test('user-facing app copy consistently uses the Idle product name', () => {
  const staleProductCopy = filesBelow('packages/idle-app/sources/text')
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => /\bIdle Coder\b/.test(read(path)))

  assert.deepEqual(staleProductCopy, [])
})
