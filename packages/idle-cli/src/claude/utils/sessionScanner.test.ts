import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import type { ClaudeGoalStatusTranscriptEvent } from '../claudeGoalStatus'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getProjectPath } from './path'

describe('sessionScanner', () => {
  let testDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let collectedTranscriptEvents: ClaudeGoalStatusTranscriptEvent[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  let originalClaudeConfigDir: string | undefined

  beforeEach(async () => {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config')

    // Use the same path calculation as the scanner to ensure paths match
    projectDir = getProjectPath(testDir)
    await mkdir(projectDir, { recursive: true })

    collectedMessages = []
    collectedTranscriptEvents = []
  })

  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }

    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true })
    }

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
  })

  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    //
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())

    const sessionId1 = '11111111-1111-4111-8111-111111111111'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)

    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = collectedMessages[0].message.content
      const text = typeof content === 'string' ? content : (content as any)[0].text
      expect(text).toBe('say lol')
    }

    // Write second line with delay
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile1, lines1[1] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant' && collectedMessages[1].message) {
      expect((collectedMessages[1].message.content as any)[0].text).toBe('lol')
    }

    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())

    const sessionId2 = '22222222-2222-4222-8222-222222222222'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)

    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length

    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)

    scanner.onNewSession(sessionId2)
    await new Promise(resolve => setTimeout(resolve, 100))

    // Should have added only 1 new message (summary)
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')

    // Write new messages (user asks for ls tool) - this is line 3
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile2, lines2[3] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))

    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(lastUserMsg.message.content).toBe('run ls tool ')
    }

    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 300))

    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)

    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)

    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant' && lastAssistantMsg.message?.content) {
      const content = (lastAssistantMsg.message.content as any)[0].text
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })

  it('emits goal status attachments through transcript events only', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = '90000000-0000-4000-8000-000000000001'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
    expect(collectedTranscriptEvents[0]).toMatchObject({
      type: 'goal_status',
      uuid: '10000000-0000-4000-8000-000000000001',
      sourceSessionId: sessionId,
      attachment: {
        type: 'goal_status',
        met: false,
        condition: 'keep this fixture goal active until explicitly cleared',
      },
    })
  })

  it('does not re-emit duplicate goal status transcript events', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = '90000000-0000-4000-8000-000000000001'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await appendFile(sessionFile, goalStatus)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
  })

  it('pre-marks existing goal status events from the initial session id', async () => {
    const activeGoalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const editedGoalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'edit-active.jsonl'), 'utf-8')
    const sessionId = '90000000-0000-4000-8000-000000000001'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, activeGoalStatus)

    scanner = await createSessionScanner({
      sessionId,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(0)

    await appendFile(sessionFile, editedGoalStatus)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
    expect(collectedTranscriptEvents[0]).toMatchObject({
      uuid: '10000000-0000-4000-8000-000000000002',
      sourceSessionId: sessionId,
      attachment: {
        type: 'goal_status',
        met: false,
        condition: 'replace this fixture goal with an edited objective',
      },
    })
  })

  it('pre-marks existing goal status events when new session treats existing entries as processed', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = '90000000-0000-4000-8000-000000000001'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId, { treatExistingAsProcessed: true })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(0)
  })

  it('drops a phantom session whose transcript never appears and keeps serving real ones', async () => {
    // A missing transcript must time out without blocking later sessions.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      missingFileTimeoutMs: 100,
    })

    // Phantom: announced but no file on disk, ever.
    const phantomId = 'fd4aa0c2-000a-4cd3-a066-80c6d87c3456'
    scanner.onNewSession(phantomId)

    // Long enough for the first ~1s backoff + give-up to fire.
    await new Promise((r) => setTimeout(r, 2500))

    expect(collectedMessages).toHaveLength(0)

    // A real session arriving after the phantom was dropped must still work.
    const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines = fixture.split('\n').filter((l) => l.trim())
    const realId = '11111111-1111-4111-8111-111111111111'
    const realFile = join(projectDir, `${realId}.jsonl`)

    await writeFile(realFile, lines[0] + '\n')
    scanner.onNewSession(realId)
    await new Promise((r) => setTimeout(r, 200))

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
  })
})
