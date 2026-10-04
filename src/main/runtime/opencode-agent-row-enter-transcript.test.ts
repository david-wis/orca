/**
 * Proof that the agent-row signal is the moment OpenCode 2 can submit. Both captures are cold
 * `--standalone` starts launched four at a time; each pasted the same brief and pressed Enter
 * (promptSentAtMs) — one once the agent row was painted, one at the box's show-cursor before it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { readTimedRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'

const HELD_PASTE = '[Pasted ~'
const BRIEF_TASK_LINE = 'Task: reply with the single word'

async function replayEnter(name: string) {
  const fixture = readTimedRuntimeFixture(name)
  const meta: { cols: number; rows: number } = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.meta.json`), 'utf8')
  )
  const scanner = createDraftPasteReadyScanner(TUI_AGENT_CONFIG.opencode2.draftPasteReadySignal!)
  const readyRead = fixture.chunks.findIndex((chunk) => scanner.observe(chunk).ready)
  let lastScreen: string[] = []
  for await (const frame of replayTranscript(fixture.chunks, meta.cols, meta.rows)) {
    lastScreen = frame.screenLines
  }
  return {
    readyAtMs: fixture.times[readyRead],
    enterAtMs: fixture.promptSentAtMs!,
    lastScreen: lastScreen.join('\n')
  }
}

describe('an Enter OpenCode 2 receives after the agent-row signal submits', () => {
  it('submits the brief when Enter follows the signal', async () => {
    const { readyAtMs, enterAtMs, lastScreen } = await replayEnter(
      'opencode-2-0-21-timed-enter-at-agent-row'
    )
    expect(readyAtMs).toBeLessThanOrEqual(enterAtMs)
    expect(lastScreen).not.toContain(HELD_PASTE)
    expect(lastScreen).toContain(BRIEF_TASK_LINE)
  })

  it('leaves the brief in the composer when Enter came at the box, before the signal', async () => {
    const { readyAtMs, enterAtMs, lastScreen } = await replayEnter(
      'opencode-2-0-21-timed-enter-at-box'
    )
    expect(enterAtMs).toBeLessThan(readyAtMs)
    expect(lastScreen).toContain(HELD_PASTE)
    expect(lastScreen).not.toContain(BRIEF_TASK_LINE)
  })
})
