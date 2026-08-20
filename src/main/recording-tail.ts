// Keep the microphone and live Deepgram stream open for a brief moment after
// the user presses Stop. Audio capture and worklet delivery are asynchronous;
// stopping both pipelines on the same event-loop turn can discard the final
// frames when the button is pressed immediately after the last syllable.
//
// 300 ms is long enough to drain the browser/audio-device buffers (which emit
// 50 ms frames) without making the stop action feel sluggish.
export const STOP_TAIL_CAPTURE_MS = 300

type Sleep = (milliseconds: number) => Promise<void>

const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export function waitForStopTail(wait: Sleep = sleep): Promise<void> {
  return wait(STOP_TAIL_CAPTURE_MS)
}
