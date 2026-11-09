import type { ServeSupervisorMessage } from '../../shared/serve-update-handoff'
import { markFullProcessQuitRequested, quitProcess } from './process-quit-request'

/** Deliver intentional stop before quitting so --supervise does not restart the server. */
export function quitServeFromTray(): void {
  markFullProcessQuitRequested()
  if (!process.connected || !process.send) {
    quitProcess()
    return
  }
  try {
    process.send({ type: 'orca:serve-quit' } satisfies ServeSupervisorMessage, (error) => {
      if (error) {
        console.error('[serve] could not request server stop', error)
        return
      }
      quitProcess()
    })
  } catch (error) {
    console.error('[serve] could not request server stop', error)
  }
}
