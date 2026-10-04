import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'

export function trackRichMarkdownLargePasteHistory(editor: Editor, onInterrupt: () => void) {
  const key = new PluginKey('richMarkdownLargePasteHistory')
  let writingChunk = false
  let active = true
  editor.registerPlugin(
    new Plugin({
      key,
      filterTransaction(transaction, state) {
        // Appended changes stay in their initiating transaction's undo event.
        if (!writingChunk && state === editor.state && transaction.docChanged) {
          closeHistory(transaction)
          onInterrupt()
        }
        return true
      }
    })
  )
  return {
    dispatchChunk(transaction: Transaction): void {
      writingChunk = true
      try {
        editor.view.dispatch(transaction)
      } finally {
        writingChunk = false
      }
    },
    dispose(): void {
      if (!active) {
        return
      }
      active = false
      if (!editor.isDestroyed) {
        editor.unregisterPlugin(key)
      }
    }
  }
}
