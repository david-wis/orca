import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'

export function trackRichMarkdownLargePasteHistory(editor: Editor, onInterrupt: () => void) {
  const key = new PluginKey('richMarkdownLargePasteHistory')
  let writingChunk = false
  let externalBoundaryStarted = false
  let active = true
  editor.registerPlugin(
    new Plugin({
      key,
      filterTransaction(transaction, state) {
        if (!writingChunk && state === editor.state) {
          externalBoundaryStarted = false
        }
        // An external event may first change the document in an appended transaction.
        if (!writingChunk && transaction.docChanged && !externalBoundaryStarted) {
          closeHistory(transaction)
          onInterrupt()
          externalBoundaryStarted = true
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
