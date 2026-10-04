import { test, expect } from './helpers/orca-app'
import type { Locator } from '@stablyai/playwright-test'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

async function readParagraphs(editor: Locator): Promise<string[]> {
  return editor.evaluate((element) => {
    const instance: unknown = Reflect.get(element, 'editor')
    const state: unknown =
      instance && typeof instance === 'object' ? Reflect.get(instance, 'state') : null
    const doc: unknown = state && typeof state === 'object' ? Reflect.get(state, 'doc') : null
    const forEach: unknown = doc && typeof doc === 'object' ? Reflect.get(doc, 'forEach') : null
    if (typeof forEach !== 'function') {
      throw new Error('Document unavailable')
    }
    const texts: string[] = []
    Reflect.apply(forEach, doc, [
      (node: unknown) => {
        const text: unknown =
          node && typeof node === 'object' ? Reflect.get(node, 'textContent') : null
        if (typeof text !== 'string') {
          throw new Error('Paragraph unavailable')
        }
        texts.push(text)
      }
    ])
    return texts
  })
}

test('keeps a large paste at its original selection after the caret moves', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-large-paste',
    'selection',
    testInfo.workerIndex,
    'hello world\n\nother paragraph'
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  const payload = 'PASTE_SENTINEL '.repeat(5500)
  await editor.evaluate((element, text) => {
    const instance: unknown = Reflect.get(element, 'editor')
    if (!instance || typeof instance !== 'object') {
      throw new Error('Editor unavailable')
    }
    const commands: unknown = Reflect.get(instance, 'commands')
    const select: unknown =
      commands && typeof commands === 'object' ? Reflect.get(commands, 'setTextSelection') : null
    if (typeof select !== 'function') {
      throw new Error('Selection unavailable')
    }
    element.focus()
    Reflect.apply(select, commands, [{ from: 7, to: 12 }])
    const data = new DataTransfer()
    data.setData('text/plain', text)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    )
    // Move during the production byte-measurement yield in this same input task.
    Reflect.apply(select, commands, [29])
  }, payload)
  await expect
    .poll(async () => (await readParagraphs(editor)).join('').length)
    .toBeGreaterThan(payload.length)
  await expect
    .poll(async () => (await readParagraphs(editor)).join('').match(/PASTE_SENTINEL/g)?.length ?? 0)
    .toBe(5500)
  await orcaPage.keyboard.type('!')
  await editor.evaluate((element) => element.querySelector('p')?.scrollIntoView({ block: 'start' }))
  await orcaPage.screenshot({ path: testInfo.outputPath('large-paste-after-caret-move.png') })
  const paragraphs = await readParagraphs(editor)
  const outcome = {
    bytes: Buffer.byteLength(payload),
    firstLength: paragraphs[0]?.length,
    firstPrefix: paragraphs[0]?.slice(0, 40),
    firstTextMatches: paragraphs[0] === `hello ${payload}`,
    secondLength: paragraphs[1]?.length,
    secondTextMatches: paragraphs[1] === 'other paragraph!'
  }
  await testInfo.attach('large-paste-outcome', {
    body: JSON.stringify(outcome),
    contentType: 'application/json'
  })
  expect(outcome).toEqual({
    bytes: Buffer.byteLength(payload),
    firstLength: payload.length + 6,
    firstPrefix: `hello ${payload}`.slice(0, 40),
    firstTextMatches: true,
    secondLength: 16,
    secondTextMatches: true
  })
})
