import { createSystemTray } from '../tray/system-tray'
import { getSystemTrayOptions } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'

export function createServeSystemTray(): void {
  if (process.platform !== 'linux' || !state.isServeMode) {
    return
  }
  const options = getSystemTrayOptions()
  if (options) {
    try {
      createSystemTray(options)
    } catch (error) {
      console.warn('[serve] could not create system tray', error)
    }
  }
}
