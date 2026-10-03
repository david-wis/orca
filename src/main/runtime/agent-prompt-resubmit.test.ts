import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptResubmit } from './agent-prompt-resubmit'
import {
  resolveTerminalPromptSettlementAgent,
  verifyAgentPromptSubmission,
  type AgentPromptActivity
} from './agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

const POLICY = TUI_AGENT_CONFIG.opencode.submitRetryUntilTurnStart!

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    generation: 1,
    permissionSequence: 0,
    workingSequence: 0,
    explicitWorkingStartedAt: null,
    outputSequence: 0,
    status: 'idle',
    ...overrides
  }
}

/** A pane whose turn starts on the Nth Enter (the first Enter was the original submit). */
function pane(turnStartsOnEnter: number) {
  const state = {
    current: activity(),
    enters: 1,
    hooksReporting: true,
    blockWrites: false
  }
  const writeEnter = vi.fn(() => {
    state.enters += 1
    if (state.enters >= turnStartsOnEnter) {
      state.current = activity({ explicitWorkingStartedAt: 1_000, status: 'working' })
    }
    return true
  })
  const resubmit = createAgentPromptResubmit({
    agent: 'opencode',
    hooksReporting: () => state.hooksReporting,
    assertSafe: () => {
      if (state.current.status === 'permission') {
        throw new Error('agent_prompt_blocked')
      }
    },
    writeEnter
  })
  return { state, writeEnter, resubmit }
}

function verify(p: ReturnType<typeof pane>, timeoutMs = 30_000) {
  return verifyAgentPromptSubmission({
    baseline: activity(),
    readActivity: () => p.state.current,
    allowOutputEvidence: false,
    timeoutMs,
    resubmit: p.resubmit
  })
}

describe('agent prompt resubmit', () => {
  afterEach(() => vi.useRealTimers())

  it('is configured only for agents whose row asks for it', () => {
    const noop = { hooksReporting: () => true, assertSafe: () => {}, writeEnter: () => true }
    expect(createAgentPromptResubmit({ agent: 'opencode', ...noop })).toBeDefined()
    expect(createAgentPromptResubmit({ agent: 'opencode2', ...noop })).toBeDefined()
    for (const agent of ['claude', 'codex', 'antigravity', 'grok'] as const) {
      expect(createAgentPromptResubmit({ agent, ...noop })).toBeUndefined()
    }
    expect(createAgentPromptResubmit({ agent: null, ...noop })).toBeUndefined()
  })

  it('sends nothing when the first Enter started the turn', async () => {
    vi.useFakeTimers()
    const p = pane(1)
    p.state.current = activity({ explicitWorkingStartedAt: 1_000, status: 'working' })

    await expect(verify(p)).resolves.toBeUndefined()
    expect(p.writeEnter).not.toHaveBeenCalled()
  })

  it.each([2, 3, POLICY.maxRetries + 1])(
    'keeps pressing Enter on the interval until the turn starts on Enter %i',
    async (enter) => {
      vi.useFakeTimers()
      const p = pane(enter)
      const verification = verify(p)

      await vi.advanceTimersByTimeAsync(POLICY.intervalMs * (enter - 1) + 100)

      await expect(verification).resolves.toBeUndefined()
      expect(p.writeEnter).toHaveBeenCalledTimes(enter - 1)
    }
  )

  it('waits a full interval before the first extra Enter', async () => {
    vi.useFakeTimers()
    const p = pane(99)
    void verify(p).catch(() => {})

    await vi.advanceTimersByTimeAsync(POLICY.intervalMs - 100)
    expect(p.writeEnter).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(p.writeEnter).toHaveBeenCalledTimes(1)
  })

  it('stops at maxRetries and reports the turn as unobserved once the budget ends', async () => {
    vi.useFakeTimers()
    const p = pane(99)
    const verification = verify(p, 30_000)
    const settled = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(30_100)

    await settled
    expect(p.writeEnter).toHaveBeenCalledTimes(POLICY.maxRetries)
  })

  it('never presses Enter while the pane has no hook status, so a hidden prompt is never answered', async () => {
    vi.useFakeTimers()
    const p = pane(2)
    p.state.hooksReporting = false
    const verification = verify(p, 10_000)
    const settled = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(10_100)

    await settled
    expect(p.writeEnter).not.toHaveBeenCalled()
  })

  it('resumes once hooks start reporting mid-wait', async () => {
    vi.useFakeTimers()
    const p = pane(2)
    p.state.hooksReporting = false
    const verification = verify(p)

    await vi.advanceTimersByTimeAsync(POLICY.intervalMs * 2)
    expect(p.writeEnter).not.toHaveBeenCalled()
    p.state.hooksReporting = true
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs + 100)

    await expect(verification).resolves.toBeUndefined()
    expect(p.writeEnter).toHaveBeenCalledTimes(1)
  })

  it('stops without another Enter when a permission prompt appears mid-wait', async () => {
    vi.useFakeTimers()
    const p = pane(99)
    const verification = verify(p)
    const settled = expect(verification).rejects.toThrow('agent_prompt_blocked')

    await vi.advanceTimersByTimeAsync(POLICY.intervalMs + 100)
    expect(p.writeEnter).toHaveBeenCalledTimes(1)
    p.state.current = activity({ status: 'permission' })
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs * 3)

    await settled
    expect(p.writeEnter).toHaveBeenCalledTimes(1)
  })

  it('refuses the Enter itself when a prompt appeared between the check and the write', async () => {
    vi.useFakeTimers()
    const writeEnter = vi.fn(() => true)
    const resubmit = createAgentPromptResubmit({
      agent: 'opencode',
      hooksReporting: () => true,
      assertSafe: () => {
        throw new Error('agent_prompt_blocked')
      },
      writeEnter
    })!

    await expect(resubmit.send()).rejects.toThrow('agent_prompt_blocked')
    expect(writeEnter).not.toHaveBeenCalled()
  })

  it('stops without another Enter when the pane is replaced mid-wait', async () => {
    vi.useFakeTimers()
    const p = pane(99)
    const verification = verify(p)
    const settled = expect(verification).rejects.toThrow('terminal_handle_stale')

    await vi.advanceTimersByTimeAsync(POLICY.intervalMs + 100)
    p.state.current = activity({ generation: 2 })
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs * 3)

    await settled
    expect(p.writeEnter).toHaveBeenCalledTimes(1)
  })

  it('routes each Enter through the caller serialisation when given one', async () => {
    const order: string[] = []
    const resubmit = createAgentPromptResubmit({
      agent: 'opencode2',
      hooksReporting: () => true,
      assertSafe: () => order.push('check'),
      writeEnter: () => {
        order.push('write')
        return true
      },
      serialize: async (send) => {
        order.push('lock')
        return await send()
      }
    })!

    await expect(resubmit.send()).resolves.toBe(true)
    expect(order).toEqual(['lock', 'check', 'write'])
  })
})

describe('resolveTerminalPromptSettlementAgent', () => {
  const hooksOn = (): boolean => true
  const hooksOff = (): boolean => false

  it('keeps the hook-and-title providers regardless of the hooks setting', () => {
    expect(resolveTerminalPromptSettlementAgent('claude', undefined, hooksOff)).toBe('claude')
    expect(resolveTerminalPromptSettlementAgent(undefined, 'codex', hooksOff)).toBe('codex')
    expect(resolveTerminalPromptSettlementAgent('antigravity', null, hooksOff)).toBe('antigravity')
  })

  it('observes a retrying agent only while its status hooks are enabled', () => {
    expect(resolveTerminalPromptSettlementAgent('opencode', undefined, hooksOn)).toBe('opencode')
    expect(resolveTerminalPromptSettlementAgent(undefined, 'opencode2', hooksOn)).toBe('opencode2')
    expect(resolveTerminalPromptSettlementAgent('opencode', undefined, hooksOff)).toBeNull()
  })

  it('prefers an established provider over a retrying one and ignores other agents', () => {
    expect(resolveTerminalPromptSettlementAgent('opencode', 'codex', hooksOn)).toBe('codex')
    expect(resolveTerminalPromptSettlementAgent('grok', 'cursor', hooksOn)).toBeNull()
  })
})
