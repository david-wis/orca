import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYUlEQVR4nO3PIREAIBAAMFqhMWgyUYMun4QQaBQZEO92twIrZ/RUde1URUBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgO9BiprrRUgkICAgICAgICAgICAgICAgICAgICAgIfHuebLmH1pKnMwAAAABJRU5ErkJggg=='

async function selectWorld(editor: Locator): Promise<void> {
  await editor.evaluate((element) => {
    const instance: unknown = Reflect.get(element, 'editor')
    if (!instance || typeof instance !== 'object') {
      throw new Error('Markdown editor unavailable')
    }
    const commands: unknown = Reflect.get(instance, 'commands')
    const select: unknown =
      commands && typeof commands === 'object' ? Reflect.get(commands, 'setTextSelection') : null
    if (typeof select !== 'function') {
      throw new Error('Markdown selection command unavailable')
    }
    element.focus()
    Reflect.apply(select, commands, [{ from: 7, to: 12 }])
  })
}

async function pasteImage(editor: Locator): Promise<void> {
  await editor.evaluate((element, png) => {
    const data = new DataTransfer()
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      })
    )
  }, PNG)
}

test('image paste replaces its selection after editing during clipboard import', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-image',
    'async-image',
    testInfo.workerIndex,
    'hello world\n\nThe selected word should be replaced by this image.'
  )
  const imagePath = testInfo.outputPath('deferred-image.png')
  await writeFile(imagePath, Buffer.from(PNG, 'base64'))
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  registerPostElectronShutdownCleanup(() =>
    cleanupMarkdownFixture(path.join(path.dirname(filePath), path.basename(imagePath)))
  )
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await selectWorld(editor)
  await expect.poll(() => orcaPage.evaluate(() => window.getSelection()?.toString())).toBe('world')
  await orcaPage.screenshot({ path: testInfo.outputPath('image-selected-before-paste.png') })

  // Substitute clipboard persistence without reading or writing the system clipboard.
  await electronApp.evaluate(({ ipcMain }, imagePath) => {
    ipcMain.removeHandler('clipboard:saveImageAsTempFile')
    ipcMain.handle(
      'clipboard:saveImageAsTempFile',
      () =>
        new Promise<string>((resolve) => {
          Reflect.set(globalThis, '__markdownImagePasteRelease', () => resolve(imagePath))
        })
    )
  }, imagePath)
  await pasteImage(editor)
  await expect
    .poll(() =>
      electronApp.evaluate(
        () => typeof Reflect.get(globalThis, '__markdownImagePasteRelease') === 'function'
      )
    )
    .toBe(true)

  const startOfLine = await orcaPage.evaluate(() =>
    navigator.userAgent.includes('Mac') ? 'Meta+ArrowLeft' : 'Home'
  )
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.press(startOfLine)
  await orcaPage.keyboard.type('prefix ')
  await expect(editor.locator('p').first()).toHaveText('prefix hello world')
  await electronApp.evaluate(() => {
    const release: unknown = Reflect.get(globalThis, '__markdownImagePasteRelease')
    if (typeof release !== 'function') {
      throw new Error('Clipboard import not pending')
    }
    release()
    Reflect.deleteProperty(globalThis, '__markdownImagePasteRelease')
  })
  const image = editor.locator('img:not(.ProseMirror-separator)')
  await expect(image).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      )
    )
    .toBe(true)
  await orcaPage.keyboard.type('continued ')
  await orcaPage.screenshot({ path: testInfo.outputPath('image-after-delayed-paste.png') })
  await testInfo.attach('image-after-delayed-paste', {
    path: testInfo.outputPath('image-after-delayed-paste.png'),
    contentType: 'image/png'
  })
  await expect(editor.locator('p').first()).toHaveText('prefix continued hello ')
  await expect(editor.locator('p').nth(1)).toHaveText(
    'The selected word should be replaced by this image.'
  )
})
