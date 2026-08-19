// AudioWorkletProcessor for the Deepgram live-transcription path.
//
// Plain JS on purpose: AudioWorklet modules are fetched and evaluated inside
// the audio rendering thread's worklet scope — they can't go through this
// project's tsc build (no DOM lib, no module wrappers allowed), so this file
// is staged verbatim by scripts/copy-assets.mjs next to recorder.html and
// loaded via ctx.audioWorklet.addModule('pcm-worklet.js').
//
// Job: repackage the audio thread's 128-sample render quanta into fixed
// 800-sample frames (50 ms @ 16 kHz) of little-endian int16 PCM — exactly
// the wire format Deepgram's linear16 socket expects. 50 ms is the sweet
// spot: small enough that interim words appear promptly, large enough that
// IPC/WebSocket overhead stays negligible (20 msgs/s, 1.6 kB each).
//
// Frames are posted with a TRANSFERRED buffer (zero copy off the audio
// thread); a fresh Int16Array is allocated per frame — 1.6 kB every 50 ms is
// nothing, and reusing a transferred buffer is a detached-buffer bug waiting
// to happen.

class Pcm16FramesProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.FRAME_SAMPLES = 800 // 50 ms @ 16 kHz
    this.frame = new Int16Array(this.FRAME_SAMPLES)
    this.filled = 0
    // 'flush' arrives at stop time: emit whatever partial frame is pending so
    // the last spoken syllable isn't stranded below the 800-sample threshold.
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush()
    }
  }

  flush() {
    if (this.filled === 0) return
    // slice() copies into a right-sized standalone buffer — safe to transfer.
    const tail = this.frame.slice(0, this.filled)
    this.filled = 0
    this.port.postMessage(tail, [tail.buffer])
  }

  process(inputs) {
    // inputs[0] = first (only) connected node; [0] = mono channel. The graph
    // can deliver empty input during setup/teardown ticks — keep the
    // processor alive and wait, never bail (returning false kills the node).
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    // The loop is length-agnostic: whether the UA hands us one 128-sample
    // quantum or batches several, frames fill across process() calls
    // (800 = 6.25 quanta, so every frame boundary lands mid-quantum).
    for (let i = 0; i < channel.length; i++) {
      // Float32 [-1, 1] → int16. Clamp defensively so malformed upstream
      // samples cannot overflow into loud clicks.
      let s = channel[i]
      if (s > 1) s = 1
      else if (s < -1) s = -1
      // Asymmetric scale (32767 vs 32768) keeps +1.0 in range without
      // clipping logic on the positive side.
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff

      if (this.filled === this.FRAME_SAMPLES) {
        const full = this.frame
        this.frame = new Int16Array(this.FRAME_SAMPLES)
        this.filled = 0
        this.port.postMessage(full, [full.buffer])
      }
    }
    return true
  }
}

registerProcessor('pcm16-frames', Pcm16FramesProcessor)
