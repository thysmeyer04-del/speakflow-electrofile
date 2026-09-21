import { clipboard, type NativeImage } from 'electron'

// Selection capture and injection share one queue. Native clipboard readers
// consume paste asynchronously, so callers must include their settle time.
let queue: Promise<unknown> = Promise.resolve()
export function withClipboard<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation)
  queue = next.catch(() => undefined)
  return next
}

export function snapshotClipboard(): () => void {
  const text = clipboard.readText()
  const html = clipboard.readHTML()
  const rtf = clipboard.readRTF()
  const image: NativeImage = clipboard.readImage()
  return () => {
    if (text || html || rtf || !image.isEmpty()) {
      clipboard.write({ text, html, rtf, ...(!image.isEmpty() ? { image } : {}) })
    } else {
      clipboard.clear()
    }
  }
}

// Never overwrite a clipboard the user changed while we were working.
export function clipboardStillContains(text: string): boolean {
  return clipboard.readText() === text &&
    clipboard.availableFormats().every((format) =>
      ['text/plain', 'public.utf8-plain-text', 'public.utf16-external-plain-text'].includes(format))
}
