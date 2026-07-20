import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const scanRoots = ['packages', 'environments', 'patches']
const cStyleExtensions = new Set([
  '.c', '.cc', '.cpp', '.css', '.h', '.hpp', '.java', '.js', '.jsx',
  '.mjs', '.cjs', '.rs', '.swift', '.ts', '.tsx',
])
const hashStyleExtensions = new Set([
  '.bash', '.py', '.rb', '.sh', '.toml', '.yaml', '.yml', '.zsh',
])

const rules = [
  ['dated-narrative', /\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/i],
  ['commit-hash', /\bcommit(?:s)?(?:\s+hash(?:es)?)?\s*(?:[:=(/+]|\s)\s*[0-9a-f]{7,40}\b/i],
  ['commit-attribution', /\bcommit attribution\b/i],
  ['commit-diary', /\b(?:same|this) commit\b|\bbefore this commit\b/i],
  ['upstream-hash', /\bupstream\s*:?\s*[0-9a-f]{7,40}\b/i],
  ['pre-fix-diary', /\bpre-fix\b/i],
  ['user-request-diary', /\bas per (?:the )?user(?:'s|s') request\b/i],
  ['issue-diary', /\bissue\s+#\d+\b|\bsame root cause\b/i],
  ['historical-implementation-diary', /\bwere written here historically\b/i],
  ['regression-narrative', /\bno regression risk\b|\bif anything regresses\b|\bsecurity regression\b/i],
  ['build-diary', /\b(?:through\s+)?build\s+#?\d+(?:\s*[/–-]\s*\d+)?\b|\b(?:this|previous) build\b/i],
  ['workday-label', /\bW(?:\d+)?[-–]D(?:\d+)?\b/i],
  ['history-rewrite', /\bpost-filter-repo\b/i],
  ['restoration-narrative', /\b(?:restored from|this restoration|re-?added(?:\s+in|\s*:)|re-fork|old-main)\b/i],
  ['stale-design-disclaimer', /\bUNDER REVIEW\b|\bnot used in production\b|\btypes? (?:are|is) kept here for reference but (?:are|is) frozen\b/i],
  ['change-diary', /\bpreviously\b/i],
  ['maintainer-backlog', /\b(?:for now|future v\d+|future factories?|future handlers?|is a follow-up)\b/i],
  ['audit-diary', /\b(?:security fix|pen[- ]test hardening|removed catch-all|root cause|anti-regression|regression test|this test verifies the fix|before the fix|new design|old behavior|used to reset)\b/i],
  ['implementation-diary', /\b(?:(?:previous|prior|old|original) (?:implementation|version|behavior|XSS)|replac(?:es|ed|ing) (?:the )?(?:prior|legacy)|works today|cross-bucket fix|variant [A-Z] only|debug view|inline control below)\b/i],
  ['pull-request-diary', /\b(?:bug|fix(?:ed|es)?)\s+(?:in\s+)?PR\s*#\d+\b|\bPR\s*#\d+\s+(?:fixed|introduced)\b/i],
  ['public-tracker-diary', /https?:\/\/[^\s]+\/(?:issues|pull)\/\d+\b|\b(?:issues?|pull requests?|PRs?)\s*#?\d+\b|\(#\d+\)|\bfrom\s+[A-Za-z0-9_-]+\/PR#\d+\b/i],
  ['first-person-change-diary', /\bI\s+(?:added|changed|fixed|moved|removed|replaced|restored)\b|\bwe\s+(?:added|changed|fixed|got a report|moved|removed|replaced|restored)\b/i],
  ['internal-ui-diary', /\bper spec\b|\bpromoted to top\b|\bmoved here\b|\bv\d+ declutter\b|\bmerged the old\b|\bhidden until .*issues? (?:are|is) fixed\b|\bproduction missing\b|\bswallows?\s+\d{3}\b|\blegacy users\b/i],
  ['disabled-test-diary', /\bcurrently broken\b|\bunclear if\b|\bpost migrat(?:e|ed|ing|ion)\b|\bremoveing\b/i],
  ['stale-removal-note', /\bto be removed\b/i],
]

const commentedExecutable = /^\s*(?:import|export)\b|^\s*(?:console|log|SystemUI)\s*\./

const retiredMaintenanceOnlyModules = [
  'patches/expose-pierre-diffs-style.cjs',
  'patches/fix-livekit-room-reuse.cjs',
  'patches/fix-pierre-trees-preact-hooks.cjs',
  'patches/force-preact-cjs.cjs',
  'packages/idle-app/sources/brand/IdleIcon.tsx',
  'packages/idle-app/sources/brand/iconColors.ts',
  'packages/idle-app/sources/brand/idleIcons.ts',
  'packages/idle-app/sources/components/CompactGitStatus.tsx',
  'packages/idle-app/sources/components/ConnectButton.tsx',
  'packages/idle-app/sources/components/ErrorBoundary.tsx',
  'packages/idle-app/sources/components/ExternalLink.tsx',
  'packages/idle-app/sources/components/InlineFileDiff.tsx',
  'packages/idle-app/sources/components/PlaceholderContainerView.tsx',
  'packages/idle-app/sources/components/PlusPlus.tsx',
  'packages/idle-app/sources/components/PlusPlus.web.tsx',
  'packages/idle-app/sources/components/SearchableListSelector.tsx',
  'packages/idle-app/sources/components/SessionContextMenu.ts',
  'packages/idle-app/sources/components/SessionsListRowAccessory.tsx',
  'packages/idle-app/sources/components/ShimmerView.tsx',
  'packages/idle-app/sources/components/TransitionStack.tsx',
  'packages/idle-app/sources/components/entityColor.ts',
  'packages/idle-app/sources/components/qr/index.ts',
  'packages/idle-app/sources/hooks/useAsyncCommand.ts',
  'packages/idle-app/sources/hooks/useAutocompleteSession.ts',
  'packages/idle-app/sources/hooks/useGetPath.ts',
  'packages/idle-app/sources/hooks/useMultiClick.ts',
  'packages/idle-app/sources/hooks/useSearch.ts',
  'packages/idle-app/sources/encryption/hex.ts',
  'packages/idle-app/sources/sync/git-parsers/parseBranch.ts',
  'packages/idle-app/sources/sync/git-parsers/parseStatus.ts',
  'packages/idle-app/sources/utils/debounce.ts',
  'packages/idle-app/sources/utils/formatPermissionParams.ts',
  'packages/idle-app/sources/utils/loadSkia.ts',
  'packages/idle-app/sources/utils/loadSkia.web.ts',
  'packages/idle-app/sources/utils/messageUtils.ts',
  'packages/idle-app/sources/utils/stringUtils.ts',
  'packages/idle-app/sources/utils/toSnakeCase.ts',
  'packages/idle-app/sources/utils/toolComparison.ts',
  'packages/idle-cli/src/api/auth.ts',
  'packages/idle-cli/src/gemini/utils/promptUtils.ts',
  'packages/idle-cli/src/modules/proxy/startHTTPDirectProxy.ts',
  'packages/idle-cli/src/ui/ink/DaemonPrompt.tsx',
  'packages/idle-cli/src/ui/messageFormatter.ts',
  'packages/idle-cli/src/utils/MessageQueue.ts',
  'packages/idle-cli/src/utils/backupKey.ts',
  'packages/idle-cli/src/utils/deriveKey.appspec.ts',
  'packages/idle-cli/src/utils/fileAtomic.ts',
  'packages/idle-cli/src/utils/hex.ts',
  'packages/idle-cli/src/utils/text.ts',
  'packages/idle-server/sources/storage/redis.ts',
  'packages/idle-server/sources/storage/repeatKey.ts',
  'packages/idle-server/sources/storage/simpleCache.ts',
  'packages/idle-server/sources/utils/lru.ts',
  'packages/idle-server/sources/utils/objects.ts',
  'packages/idle-server/sources/utils/trimIdent.ts',
  'packages/idle-server/sources/utils/uptime.ts',
]

const shippedCliBacklogPaths = [
  'packages/idle-cli/src/api/pushNotifications.ts',
  'packages/idle-cli/src/claude/claudeLocal.ts',
  'packages/idle-cli/src/claude/claudeRemote.ts',
  'packages/idle-cli/src/claude/sdk/buildSpawnEnv.ts',
  'packages/idle-cli/src/claude/session.ts',
  'packages/idle-cli/src/claude/utils/permissionHandler.ts',
  'packages/idle-cli/src/codex/runCodex.ts',
  'packages/idle-cli/src/daemon/controlClient.ts',
  'packages/idle-cli/src/daemon/run.ts',
  'packages/idle-cli/src/modules/watcher/startFileWatcher.ts',
  'packages/idle-cli/src/ui/auth.ts',
  'packages/idle-cli/src/utils/caffeinate.ts',
  'packages/idle-cli/src/utils/detectCLI.ts',
  'packages/idle-cli/src/utils/serverConnectionErrors.ts',
  'packages/idle-cli/scripts/claude_version_utils.cjs',
]
const shippedServerBacklogPaths = [
  'packages/idle-server/sources/app/account/accountDelete.ts',
  'packages/idle-server/sources/app/api/api.ts',
  'packages/idle-server/sources/app/api/idleRoutes.ts',
  'packages/idle-server/sources/app/api/routes/_schemas.ts',
  'packages/idle-server/sources/app/api/routes/adminRoutes.ts',
  'packages/idle-server/sources/app/api/routes/voiceRoutes.ts',
]
const internalBacklogComment = /\bTODO\b|\bFIXME\b|\bHACK\b|\bbacklog\b|\bpreviously\b|\bwe found\b|\breserved for future\b|\bin future\b|\bpotential future\b|\bfuture use\b|\bkept for\b|\bnot used\b|\bshould probably\b|\blong-term\b/i
const projectMaintenanceDiary = /\bfork-only\b|\bupstream-tracked\b|\bNorthglass-specific\b|\bIdle (?:addition|difference|keeps)\b|\bupstream mechanism\b|\bremove once\b|\bpreserve across upstream\b|\b(?:staged )?client migration\b|\bproduction v\d+\b|\bClaude\/Opus\b/i
const shippedAppMaintenanceDiary = /\b(?:slopus|happy)\b|\bcherry[- ]pick(?:ing|s)?\b|\bfork-only\b|\bupstream-tracked\b|\bupstream(?:'s|\s+(?:changes?|edits?|refactor|improvement|hardening|mechanism|status wiring|went|deleted|localsettings|#\w+|\d))\b|\bpen[- ]test\b|\bremediation\b|\b(?:TODO|HACK)\b|\btemporary until\b|\bphase \d+ (?:should|of)\b|\brevisit this logic\b|\bUX overhaul\b|\bSEND-\d+\b/i

function isScannable(path) {
  const extension = extname(path).toLowerCase()
  return cStyleExtensions.has(extension)
    || hashStyleExtensions.has(extension)
    || basename(path).startsWith('.env')
}

function filesBelow(relativeRoot) {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relativeRoot],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
    .filter((path) => existsSync(join(root, path)) && isScannable(path))
}

function extractCStyleComments(source) {
  const comments = []
  let index = 0
  let line = 1
  let quote = null
  let escaped = false

  const advance = () => {
    if (source[index] === '\n') line += 1
    index += 1
  }

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (quote !== null) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      advance()
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      advance()
      continue
    }

    if (char === '/' && next === '/') {
      const commentLine = line
      index += 2
      const start = index
      while (index < source.length && source[index] !== '\n') index += 1
      comments.push({ line: commentLine, text: source.slice(start, index) })
      continue
    }

    if (char === '/' && next === '*') {
      const startLine = line
      index += 2
      const start = index
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        advance()
      }
      const lines = source.slice(start, index).split('\n')
      lines.forEach((text, offset) => comments.push({ line: startLine + offset, text }))
      if (index < source.length) index += 2
      continue
    }

    advance()
  }

  return comments
}

function extractHashStyleComments(source) {
  const comments = []
  source.split('\n').forEach((line, lineIndex) => {
    let quote = null
    let escaped = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quote !== null) {
        if (escaped) escaped = false
        else if (char === '\\' && quote === '"') escaped = true
        else if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === '#') {
        comments.push({ line: lineIndex + 1, text: line.slice(index + 1) })
        return
      }
    }
  })
  return comments
}

function commentsFor(path, source) {
  const extension = extname(path).toLowerCase()
  if (hashStyleExtensions.has(extension) || basename(path).startsWith('.env')) {
    return extractHashStyleComments(source)
  }
  return extractCStyleComments(source)
}

function matchingRules(comment) {
  return rules.filter(([, pattern]) => pattern.test(comment)).map(([name]) => name)
}

test('scanner targets chronology annotations without treating literals as comments', () => {
  const source = [
    "const fixtureDate = '2026-05-18T00:00:00.000Z';",
    "const fixtureHash = '72a1be91';",
    '// stable invariant with no private chronology',
  ].join('\n')

  assert.deepEqual(extractCStyleComments(source), [
    { line: 3, text: ' stable invariant with no private chronology' },
  ])
  assert.equal(isScannable('packages/idle-app/CHANGELOG.md'), false)
  assert.deepEqual(matchingRules('shipped 2026-05-18 in Build 71'), [
    'dated-narrative',
    'build-diary',
  ])
  assert.deepEqual(matchingRules('commit 72a1be91 after post-filter-repo'), [
    'commit-hash',
    'history-rewrite',
  ])
  assert.deepEqual(matchingRules('Restored from old-main during W-D'), [
    'workday-label',
    'restoration-narrative',
  ])
  assert.deepEqual(matchingRules('Upstream: 61ac7ee1; pre-fix behavior'), [
    'upstream-hash',
    'pre-fix-diary',
  ])
  assert.deepEqual(matchingRules("As per user's request"), [
    'user-request-diary',
  ])
  assert.deepEqual(matchingRules('UNDER REVIEW: not used in production'), [
    'stale-design-disclaimer',
  ])
})

test('shipped source comments contain invariants, not private chronology', () => {
  const violations = []
  for (const scanRoot of scanRoots) {
    for (const path of filesBelow(scanRoot)) {
      const source = readFileSync(join(root, path), 'utf8')
      for (const comment of commentsFor(path, source)) {
        for (const rule of matchingRules(comment.text)) {
          violations.push(`${path}:${comment.line}:${rule}`)
        }
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('shipped source does not retain commented-out executable statements', () => {
  const violations = []
  for (const scanRoot of scanRoots) {
    for (const path of filesBelow(scanRoot)) {
      const source = readFileSync(join(root, path), 'utf8')
      for (const comment of commentsFor(path, source)) {
        if (commentedExecutable.test(comment.text)) {
          violations.push(`${path}:${comment.line}`)
        }
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('public mobile E2E tooling contains no maintainer credential or release-history recipe', () => {
  const paths = [
    'packages/idle-e2e-mobile/README.md',
    'packages/idle-e2e-mobile/package.json',
    'packages/idle-e2e-mobile/scripts/dev-client-maestro.sh',
    'packages/idle-e2e-mobile/scripts/run-authed.sh',
  ]
  const forbidden = [
    ['maintainer credential file', /asc-credentials\.env|~\/\.idle\//i],
    ['credential sourcing recipe', /^\s*(?:\.|source)\s+[^\n]*(?:credential|secret)/im],
    ['retired development bundle guess', /com\.northglass\.idle\.development\b/i],
    ['historical bundle narration', /\bwhich was a guess\b|\bcommon culprit\b/i],
    ['one-off release narration', /\binstall ONCE\b|\bone EAS build slot\b|\bwait for build\b|\bbuild the IPA via EAS\b/i],
    ['maintainer home path', /\/Users\/[A-Za-z0-9._-]+\//],
  ]
  const violations = []

  for (const path of paths) {
    const source = readFileSync(join(root, path), 'utf8')
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${path}:${label}`)
    }
  }

  assert.deepEqual(violations, [])
})

test('mobile dev-client tooling uses a private runtime directory and validates its Metro process', () => {
  const path = 'packages/idle-e2e-mobile/scripts/dev-client-maestro.sh'
  const source = readFileSync(join(root, path), 'utf8')

  assert.match(source, /umask 077/)
  assert.match(source, /mkdir -p "\$RUNTIME_DIR"/)
  assert.match(source, /stat -f ['"]%u['"] "\$RUNTIME_DIR"/)
  assert.match(source, /stat -f ['"]%Lp['"] "\$RUNTIME_DIR"/)
  assert.match(source, /ps -p "\$pid" -o uid=/)
  assert.match(source, /ps -p "\$pid" -o command=/)
  assert.doesNotMatch(source, /METRO_(?:LOG|PID_FILE)=.*(?:\/tmp|idle-metro)/)

  const stopFunction = source.match(/metro_stop\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
  const validationIndex = stopFunction.indexOf('validate_metro_pid "$pid"')
  const signalIndex = stopFunction.indexOf('kill -- "$pid"')
  assert.ok(validationIndex >= 0)
  assert.ok(signalIndex >= 0)
  assert.ok(validationIndex < signalIndex)
})

test('production artifact and machine routes expose supported UI without debug instrumentation', () => {
  const artifactsPath = 'packages/idle-app/sources/app/(app)/artifacts/index.tsx'
  const artifacts = readFileSync(join(root, artifactsPath), 'utf8')
  assert.doesNotMatch(artifacts, /\bconsole\.(?:debug|error|info|log|warn)\s*\(/)
  assert.doesNotMatch(artifacts, /📱/u)

  const machinePath = 'packages/idle-app/sources/app/(app)/machine/[id].tsx'
  const machine = readFileSync(join(root, machinePath), 'utf8')
  assert.match(machine, /\.slice\(0,\s*5\)/)
  assert.match(machine, /<ItemGroup title=["']Recent Sessions["']>/)
  assert.doesNotMatch(machine, /debug view|Variant [A-Z]|inline control below/i)
})

test('the app excludes the unused GitHub OAuth-parameter client surface', () => {
  for (const path of [
    'packages/idle-app/sources/sync/apiGithub.ts',
    'packages/idle-app/sources/sync/apiGithub.spec.ts',
  ]) {
    const source = readFileSync(join(root, path), 'utf8')
    assert.doesNotMatch(source, /getGitHubOAuthParams|GitHubOAuthParamsSchema|validateGitHubOAuthUrl/)
  }
})

test('maintenance-only modules stay out of the shipped source graph', () => {
  const present = retiredMaintenanceOnlyModules.filter(path => existsSync(join(root, path)))
  assert.deepEqual(present, [])
})

test('shipped CLI control paths contain timeless invariants instead of maintainer backlog', () => {
  const violations = []
  for (const path of shippedCliBacklogPaths) {
    const source = readFileSync(join(root, path), 'utf8')
    for (const comment of commentsFor(path, source)) {
      if (internalBacklogComment.test(comment.text)) {
        violations.push(`${path}:${comment.line}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('shipped server control paths contain timeless invariants instead of maintainer backlog', () => {
  const violations = []
  for (const path of shippedServerBacklogPaths) {
    const source = readFileSync(join(root, path), 'utf8')
    for (const comment of commentsFor(path, source)) {
      if (internalBacklogComment.test(comment.text) || projectMaintenanceDiary.test(comment.text)) {
        violations.push(`${path}:${comment.line}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('shipped app comments describe current contracts without project-maintenance diary prose', () => {
  const violations = []
  for (const path of filesBelow('packages/idle-app/sources')) {
    const source = readFileSync(join(root, path), 'utf8')
    for (const comment of commentsFor(path, source)) {
      if (shippedAppMaintenanceDiary.test(comment.text)) {
        violations.push(`${path}:${comment.line}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})
