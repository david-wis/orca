import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../shared/opencode-agent-row-scanner'
import {
  waitForWorktreeStartupDraft,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

describe('fresh worker composer readiness', () => {
  afterEach(() => vi.useRealTimers())

  function fixture(replay?: string) {
    let listener = (_data: string): void => {}
    const unsubscribe = vi.fn()
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'zcode',
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return unsubscribe
      },
      readRecentOutput: () => replay,
      write: vi.fn()
    }
    return { host, emit: (data: string) => listener(data), unsubscribe }
  }

  it('accepts the captured composer while the banner continues repainting', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const pending = waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
      timeoutMs: 45_000,
      requireComposerMarker: true
    })
    const data = readFileSync(join(__dirname, '__fixtures__', 'zcode-composer-ready.txt'), 'utf8')
    for (let offset = 0; offset < data.length; offset += 4096) {
      h.emit(data.slice(offset, offset + 4096))
    }
    await expect(pending).resolves.toBe('pty-1')
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.host.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up the deadline when the composer was already captured', async () => {
    vi.useFakeTimers()
    const h = fixture('\x1b[?1049h╭')
    await expect(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
        timeoutMs: 45_000,
        requireComposerMarker: true
      })
    ).resolves.toBe('pty-1')
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not accept shell decoration or a square startup dialog', async () => {
    vi.useFakeTimers()
    const h = fixture('╭ shell\n\x1b[?1049h\x1b[?2004h┌ Sign in ┐')
    const pending = waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
      timeoutMs: 45_000,
      requireComposerMarker: true
    })
    await vi.advanceTimersByTimeAsync(44_999)
    expect(h.unsubscribe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeNull()
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('OpenCode submit readiness', () => {
  afterEach(() => vi.useRealTimers())

  // OpenCode 2.0.21's box with its cursor and bottom corner, then the agent row directly above it.
  const BOX = '\x1b[?1049h\x1b[?2004h\x1b[24;24H┃\x1b[25;24H╹\x1b[22;27H\x1b[?25h'
  const AGENT_ROW = '\x1b[24;27HBuild\x1b[24;33H\u00b7\x1b[24;35HSome Model'

  function fixture() {
    let listener = (_data: string): void => {}
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'opencode',
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return () => {}
      },
      readRecentOutput: () => undefined,
      write: vi.fn()
    }
    return { host, emit: (data: string) => listener(data) }
  }

  function settle(pending: Promise<string | null>): { value: string | null | undefined } {
    const result: { value: string | null | undefined } = { value: undefined }
    void pending.then((value) => (result.value = value))
    return result
  }

  it('a draft that is not submitted is pasted on the box cursor, as before', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2'))
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.value).toBe('pty-1')
  })

  it('a submitted task waits for the agent row', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(1000)
    expect(result.value).toBeUndefined()
    h.emit(AGENT_ROW)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the box after the grace when the row never comes, whatever repaints', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS - 1)
    h.emit('\x1b[22;27H\x1b[?25h')
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the box at the deadline when the grace would outlast the budget', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    await vi.advanceTimersByTimeAsync(59_000)
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(999)
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('withdraws the grace when OpenCode turns bracketed paste off', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    h.emit('\x1b[?2004l\x1b[?1049l')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBeNull()
  })
})
