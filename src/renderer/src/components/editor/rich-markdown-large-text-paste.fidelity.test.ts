// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const editors: Editor[] = []

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('keeps every byte literal with the production extensions across production chunk boundaries', async () => {
  const editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: 'hello world\n\nsecond paragraph',
    contentType: 'markdown'
  })
  editors.push(editor)
  document.body.append(editor.view.dom)
  editor.view.dom.focus()
  editor.commands.setTextSelection({ from: 7, to: 12 })
  const payload = 'PASTE_SENTINEL '.repeat(5500)
  expect(new TextEncoder().encode(payload).byteLength).toBe(82500)
  const data = new DataTransfer()
  data.setData('text/plain', payload)
  const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
  let resume: () => void = () => {}
  const delay = new Promise<void>((resolve) => {
    resume = resolve
  })
  const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay).mockResolvedValue(undefined)
  expect(handleRichMarkdownLargeTextPaste(editor, event, { yieldToEventLoop })).toBe(true)
  expect(event.defaultPrevented).toBe(true)
  expect(yieldToEventLoop).toHaveBeenCalledOnce()
  editor.commands.setTextSelection(14)
  resume()
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
  expect(editor.state.doc.child(0).textContent === `hello ${payload}`).toBe(true)
  expect(editor.state.doc.child(0).textContent.match(/PASTE_SENTINEL/g)?.length).toBe(5500)
  expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
  expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  let markedPayload = false
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text?.includes('PASTE')) {
      markedPayload ||= node.marks.length > 0
    }
  })
  expect(markedPayload).toBe(false)
  editor.commands.insertContent('!')
  expect(editor.state.doc.child(1).textContent).toBe('!second paragraph')
})

it('continues after its own chunk converts a document link while the live caret is elsewhere', async () => {
  const editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: 'hello world\n\nother paragraph',
    contentType: 'markdown'
  })
  editors.push(editor)
  document.body.append(editor.view.dom)
  editor.view.dom.focus()
  editor.commands.setTextSelection({ from: 7, to: 12 })
  const data = new DataTransfer()
  data.setData('text/plain', 'aaa[[y]]ZZZ')
  const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
  let firstYield = true
  handleRichMarkdownLargeTextPaste(editor, event, {
    directMaxBytes: 1,
    chunkMaxBytes: 8,
    measureYieldAfterCodeUnits: 1,
    yieldToEventLoop: async () => {
      if (firstYield) {
        firstYield = false
        editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
      }
    }
  })
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve()
  }
  expect(editor.getMarkdown()).toBe('hello aaa[[y]]ZZZ\n\nother paragraph')
  expect(editor.view.dom.querySelector('[data-doc-link-target="y"]')).not.toBeNull()
  expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  editor.state.doc.check()
  editor.commands.insertContent('!')
  expect(editor.getMarkdown()).toBe('hello aaa[[y]]ZZZ\n\n!other paragraph')
})
