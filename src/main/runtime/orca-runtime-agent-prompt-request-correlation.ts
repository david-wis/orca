import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import type { RuntimeTerminalPromptDelivery } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type {
  AgentPromptActivity,
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { verifyAgentPromptSubmission } from './agent-prompt-submission-verification'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'
import {
  createAgentPromptResubmit,
  getAgentSubmitRetryUntilTurnStart,
  type AgentPromptResubmit
} from './agent-prompt-resubmit'
import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'

export class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  private readonly agentPromptCorrelation = new AgentPromptRequestCorrelation()
  // Declared, not defined: both live further up the mixin chain, so this link cannot see them.
  declare protected getLivePtyForHandle: (
    handle: string
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  declare protected getLiveLeafForHandle: (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  declare protected assertAgentPromptGeneration: (ptyId: string, expected: number) => void
  declare protected assertAgentPromptPermissionSafe: (
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ) => void

  getTerminalPromptRequestBinding(handle: string): {
    ptyId: string
    processIncarnation: string
    generation: number
  } {
    const live = this.getLivePtyForHandle(handle)
    const ptyId = live?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    if (!ptyId) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(ptyId)?.incarnationId
    return {
      ptyId,
      processIncarnation: incarnationId ?? `${this.runtimeId}:${ptyId}:${generation}`,
      generation
    }
  }

  async observeTerminalAgentPrompt(
    handle: string,
    prompt: RuntimeTerminalPromptDelivery,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptDelivery> {
    const binding = this.getTerminalPromptRequestBinding(handle)
    if (
      binding.processIncarnation !== prompt.processIncarnation ||
      binding.generation !== prompt.generation
    ) {
      return { ...prompt, observation: 'incarnation_replaced' }
    }
    const waitTextCache: AgentPromptWaitTextCache = {}
    const current = this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache)
    const baseline = {
      ...current,
      workingSequence: prompt.baselineWorkingSequence,
      ...(prompt.baselinePermissionSequence !== undefined
        ? { permissionSequence: prompt.baselinePermissionSequence }
        : {}),
      ...(prompt.baselineExplicitWorkingStartedAt !== undefined
        ? { explicitWorkingStartedAt: prompt.baselineExplicitWorkingStartedAt }
        : {})
    }
    const resubmitAgent = isTuiAgentProvider(prompt.provider) ? prompt.provider : null
    try {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            binding.ptyId,
            binding.generation,
            prompt.requestId,
            prompt.baselineWorkingSequence,
            prompt.baselineExplicitWorkingStartedAt ?? null,
            evidence
          ),
        // Old hosts omit the hook baseline, so their receipts retain title-only observation.
        allowHookEvidence: prompt.baselineExplicitWorkingStartedAt !== undefined,
        allowOutputEvidence: false,
        signal,
        timeoutMs,
        resubmit: this.createObservedPromptResubmit(handle, binding, baseline, resubmitAgent)
      })
      this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
      return { ...prompt, stages: ['input_accepted', 'turn_started'], observation: 'supported' }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        // Why: such a provider is observed only through its status hooks; a pane that never
        // reported cannot show a turn, so its receipt must not read as observable-but-missing.
        return getAgentSubmitRetryUntilTurnStart(resubmitAgent) &&
          this.getFreshExplicitAgentStatusForPty(handle, binding.ptyId) === null
          ? { ...prompt, observation: 'unsupported' }
          : prompt
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
        return { ...prompt, observation: 'permission' }
      }
      throw error
    }
  }

  /** Extra Enters for a prompt observed after its write, under the pane's prompt serialisation. */
  private createObservedPromptResubmit(
    handle: string,
    binding: { ptyId: string; generation: number },
    baseline: AgentPromptActivity,
    agent: TuiAgent | null
  ): AgentPromptResubmit | undefined {
    const { ptyId, generation } = binding
    return createAgentPromptResubmit({
      agent,
      hooksReporting: () => this.getFreshExplicitAgentStatusForPty(handle, ptyId) !== null,
      assertSafe: () => {
        this.assertAgentPromptGeneration(ptyId, generation)
        this.assertAgentPromptPermissionSafe(baseline, this.getAgentPromptActivity(handle, ptyId))
      },
      writeEnter: () => this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, 'driving') === true,
      // Why: another prompt's paste may be mid-flight; an Enter between its paste and submit
      // would send it early.
      serialize: (send) => this.serializeAgentPromptSubmission(ptyId, generation, send)
    })
  }

  protected registerAgentPromptRequest(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null
  ): void {
    this.agentPromptCorrelation.register(ptyId, {
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt
    })
  }

  protected forgetAgentPromptRequest(ptyId: string, generation: number, requestId: string): void {
    this.agentPromptCorrelation.forget(ptyId, generation, requestId)
  }

  protected acceptAgentPromptTurnStart(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    return this.agentPromptCorrelation.acceptTurnStart(
      ptyId,
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt,
      evidence
    )
  }

  protected clearAgentPromptCorrelationForPty(ptyId: string): void {
    this.agentPromptCorrelation.clearForPty(ptyId)
  }
}

function isTuiAgentProvider(
  provider: RuntimeTerminalPromptDelivery['provider']
): provider is TuiAgent {
  return provider !== 'unsupported' && provider !== 'old-host'
}
