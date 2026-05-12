import { clipboard } from 'electron'
import log from 'electron-log/main'

let nutKeyboard: typeof import('@nut-tree-fork/nut-js')['keyboard'] | null = null
let nutKey: typeof import('@nut-tree-fork/nut-js')['Key'] | null = null

function loadNut() {
  if (nutKeyboard) return true
  try {
    const nut = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js')
    nutKeyboard = nut.keyboard
    nutKey = nut.Key
    nutKeyboard.config.autoDelayMs = 0
    return true
  } catch (err) {
    log.warn('nut-js not available; clipboard-only injection will be used', err)
    return false
  }
}

const FOCUS_RETURN_DELAY_MS = 150
const KEYSTROKE_LIMIT = 100

export async function injectText(text: string): Promise<void> {
  if (!text) return
  await sleep(FOCUS_RETURN_DELAY_MS)
  const nutReady = loadNut()

  if (nutReady && text.length <= KEYSTROKE_LIMIT && !containsSpecialChars(text)) {
    try {
      await nutKeyboard!.type(text)
      return
    } catch (err) {
      log.warn('Keystroke injection failed, falling back to clipboard', err)
    }
  }

  await injectViaClipboard(text, nutReady)
}

async function injectViaClipboard(text: string, nutReady: boolean): Promise<void> {
  const previous = clipboard.readText()
  const previousImage = clipboard.readImage()
  clipboard.writeText(text)

  await sleep(50)

  if (nutReady && nutKeyboard && nutKey) {
    try {
      const modifier = process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl
      await nutKeyboard.pressKey(modifier, nutKey.V)
      await sleep(30)
      await nutKeyboard.releaseKey(modifier, nutKey.V)
      await sleep(180) // wait for paste to land before clobbering clipboard
    } catch (err) {
      log.error('Paste keystroke failed', err)
    }
  } else {
    log.warn('No keystroke backend available — text left on clipboard for user to paste manually')
  }

  // Restore previous clipboard. Prefer image if there was one.
  if (!previousImage.isEmpty()) {
    clipboard.writeImage(previousImage)
  } else if (previous.length > 0) {
    clipboard.writeText(previous)
  }
}

function containsSpecialChars(text: string): boolean {
  // nut-js type() is unreliable with certain Unicode points (RTL, emoji, dead keys, etc.)
  // Conservative check: only ASCII + common punctuation goes the keystroke path.
  return !/^[\x20-\x7E\n\r\t]+$/.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
