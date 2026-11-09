import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSupervisedServeStop, resetSupervisedServeStop } from './serve-supervised-stop'
import { resumeInterruptedServeUpdate, superviseForegroundServe } from './serve-update-supervisor'
import { superviseServeService } from './serve-supervised-service'
import { readServeSupervisorBrake } from './serve-supervisor-brake'

const HANDOFF = {
  schemaVersion: 1 as const,
  phase: 'install-requested' as const,
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  servingPid: 42
}

describe('supervised update replacement spawns', () => {
  afterEach(() => {
    resetSupervisedServeStop()
    vi.restoreAllMocks()
  })

  async function resume(): Promise<{ code: number; spawnChild: ReturnType<typeof vi.fn> }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-update-gate-'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const spawnChild = vi.fn()
    try {
      const code = await resumeInterruptedServeUpdate({
        spec: { program: join(root, 'orca') },
        spawnChild,
        handoffPath: join(root, 'handoff.json'),
        handoff: HANDOFF
      })
      return { code, spawnChild }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('does not spawn a replacement when the install hold says stop', async () => {
    const gate = vi.fn(async () => false)
    resetSupervisedServeStop(gate)
    const { code, spawnChild } = await resume()
    expect(code).toBe(0)
    expect(gate).toHaveBeenCalledOnce()
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('does not spawn a replacement after a stop request', async () => {
    resetSupervisedServeStop(async () => true)
    requestSupervisedServeStop()
    const { code, spawnChild } = await resume()
    expect(code).toBe(0)
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('stops a supervised server intentionally without recording a crash or restarting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-tray-stop-'))
    try {
      const code = await superviseServeService({
        userDataPath: root,
        executable: process.execPath,
        force: false,
        readInstallEvidence: async () => ({ kind: 'clear' }),
        buildIdentity: () => 'tray-stop-build',
        runOnce: () => {
          const child = new ChildProcess()
          child.kill = () => {
            queueMicrotask(() => child.emit('exit', 0, null))
            return true
          }
          const result = superviseForegroundServe({
            child,
            spec: { program: process.execPath },
            spawnChild: () => {
              throw new Error('Stopped servers must not respawn')
            },
            handoffPath: null,
            expectedHandoff: null
          })
          queueMicrotask(() => child.emit('message', { type: 'orca:serve-quit' }))
          return result
        },
        setTimer: (callback) => {
          queueMicrotask(callback)
          return () => undefined
        }
      })
      expect(code).toBe(0)
      expect(readServeSupervisorBrake(root)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
