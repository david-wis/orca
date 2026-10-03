import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const POLICY = TUI_AGENT_CONFIG.opencode.submitRetryUntilTurnStart!
const DISPATCH_OPTIONS = {
  inputKind: 'driving' as const,
  acceptQueued: true,
  requestId: 'dispatch-1',
  observationTimeoutMs: 0
}

type Hook = { state: 'done' | 'working' | 'waiting'; stateStartedAt: number } | null

/**
 * An OpenCode pane that drops every Enter before `honoredFromEnter`, the way OpenCode 2 drops one
 * sent before its agent list loads; the honoured Enter starts a turn its status hook reports.
 */
async function createOpenCodePane(args: {
  honoredFromEnter: number
  hook: { current: Hook }
  hooksEnabled?: boolean
}) {
  let handle = ''
  const writes: string[] = []
  const baseStore = makeStore()
  const store = {
    ...baseStore,
    getSettings: () => ({
      ...baseStore.getSettings(),
      ...(args.hooksEnabled === false ? { agentStatusHooksEnabled: false } : {})
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared worktree-store fixture covers every store call this runtime makes.
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: () =>
      args.hook.current
        ? [
            {
              paneKey: 'prompt-pane',
              terminalHandle: handle,
              state: args.hook.current.state,
              prompt: '',
              agentType: 'opencode',
              connectionId: null,
              receivedAt: Date.now(),
              stateStartedAt: args.hook.current.stateStartedAt
            }
          ]
        : []
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r' && writes.filter((w) => w === '\r').length >= args.honoredFromEnter) {
        args.hook.current = { state: 'working', stateStartedAt: Date.now() }
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  handle = (
    await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
      launchAgent: 'opencode'
    })
  ).handle
  return { runtime, handle, writes, enters: () => writes.filter((w) => w === '\r').length }
}

describe('OpenCode prompt submit keeps pressing Enter until its turn starts', () => {
  afterEach(() => vi.useRealTimers())

  it('observes the turn after the Enter OpenCode finally honours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook: { current: Hook } = { current: { state: 'done', stateStartedAt: 500 } }
    const pane = await createOpenCodePane({ honoredFromEnter: 3, hook })

    const sent = sendBrief(pane)
    await vi.runAllTimersAsync()
    const receipt = (await sent).prompt!
    expect(receipt).toMatchObject({
      provider: 'opencode',
      observation: 'supported',
      stages: ['input_accepted']
    })
    expect(pane.enters()).toBe(1)

    const observed = pane.runtime.observeTerminalAgentPrompt(pane.handle, receipt, 30_000)
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs * 2 + 200)

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted', 'turn_started'],
      observation: 'supported'
    })
    expect(pane.enters()).toBe(3)
  })

  it('sends no extra Enter and reports the prompt when an approval is showing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook: { current: Hook } = { current: { state: 'done', stateStartedAt: 500 } }
    const pane = await createOpenCodePane({ honoredFromEnter: 99, hook })

    const sent = sendBrief(pane)
    await vi.runAllTimersAsync()
    const observed = pane.runtime.observeTerminalAgentPrompt(
      pane.handle,
      (await sent).prompt!,
      30_000
    )
    hook.current = { state: 'waiting', stateStartedAt: Date.now() }
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs * 3)

    await expect(observed).resolves.toMatchObject({ observation: 'permission' })
    expect(pane.enters()).toBe(1)
  })

  it("keeps today's unobserved receipt and single Enter when status hooks are off", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const pane = await createOpenCodePane({
      honoredFromEnter: 2,
      hook: { current: null },
      hooksEnabled: false
    })

    const sent = sendBrief(pane)
    await vi.runAllTimersAsync()

    expect((await sent).prompt).toMatchObject({
      provider: 'unsupported',
      observation: 'unsupported'
    })
    expect(pane.enters()).toBe(1)
  })

  it('never presses Enter blind and reports no observation when the pane never reports a hook', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const pane = await createOpenCodePane({ honoredFromEnter: 2, hook: { current: null } })

    const sent = sendBrief(pane)
    await vi.runAllTimersAsync()
    const observed = pane.runtime.observeTerminalAgentPrompt(
      pane.handle,
      (await sent).prompt!,
      10_000
    )
    await vi.advanceTimersByTimeAsync(10_200)

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted'],
      observation: 'unsupported'
    })
    expect(pane.enters()).toBe(1)
  })

  it("stops after the row's retry cap and leaves the turn honestly unobserved", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook: { current: Hook } = { current: { state: 'done', stateStartedAt: 500 } }
    const pane = await createOpenCodePane({ honoredFromEnter: 99, hook })

    const sent = sendBrief(pane)
    await vi.runAllTimersAsync()
    const observed = pane.runtime.observeTerminalAgentPrompt(
      pane.handle,
      (await sent).prompt!,
      30_000
    )
    await vi.advanceTimersByTimeAsync(30_200)

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted'],
      observation: 'supported'
    })
    expect(pane.enters()).toBe(1 + POLICY.maxRetries)
  })
})

function sendBrief(pane: Awaited<ReturnType<typeof createOpenCodePane>>) {
  return pane.runtime.sendTerminalAgentPrompt(pane.handle, 'the brief', DISPATCH_OPTIONS)
}
