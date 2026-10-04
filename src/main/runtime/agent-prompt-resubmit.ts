import type { TerminalAgent } from '../../shared/terminal-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

/**
 * Extra Enters a prompt verifier may press while no turn start is observed, for TUIs that draw
 * their composer before Enter is live (OpenCode 2 drops an Enter until its agent list loads, and
 * the bracketed paste then sits in the composer unsent).
 */
export type AgentPromptResubmit = {
  intervalMs: number
  maxRetries: number
  /** One Enter when it is safe; false when it held back for lack of hook evidence. */
  send: () => Promise<boolean>
}

export function getAgentSubmitRetryUntilTurnStart(
  agent: TerminalAgent | null | undefined
): { intervalMs: number; maxRetries: number } | undefined {
  return isTuiAgent(agent) ? TUI_AGENT_CONFIG[agent].submitRetryUntilTurnStart : undefined
}

export function createAgentPromptResubmit(args: {
  agent: TerminalAgent | null | undefined
  /** Whether this pane's status hooks are reporting right now. */
  hooksReporting: () => boolean
  /** Throws when the pane was replaced or an approval or question prompt is showing. */
  assertSafe: () => void
  writeEnter: () => boolean
  /** Runs the send under the pane's prompt serialisation when the caller does not hold it. */
  serialize?: (send: () => Promise<boolean>) => Promise<boolean>
}): AgentPromptResubmit | undefined {
  const policy = getAgentSubmitRetryUntilTurnStart(args.agent)
  if (!policy) {
    return undefined
  }
  const sendNow = async (): Promise<boolean> => {
    // Why: without hooks Orca cannot see an approval or question the Enter would answer.
    if (!args.hooksReporting()) {
      return false
    }
    args.assertSafe()
    return args.writeEnter()
  }
  return {
    intervalMs: policy.intervalMs,
    maxRetries: policy.maxRetries,
    send: () => (args.serialize ? args.serialize(sendNow) : sendNow())
  }
}
