// Deepgram Nova-3 live-transcription session, owned by the MAIN process.
//
// Why main and not the recorder renderer: main already holds the auth token,
// the proxy allowlist, and the recording state machine — and a renderer-owned
// socket would die with any renderer crash, exactly the moment the batch
// fallback machinery in main needs to keep working. The recorder renderer
// only ships raw PCM frames up over IPC; this module owns the socket.
//
// Protocol (per the Deepgram streaming API):
//   connect  wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&
//            sample_rate=16000&channels=1&smart_format=true&
//            interim_results=true&language=en
//            with header  Authorization: Bearer <grant token from /asr-token>
//   send     binary frames of raw little-endian int16 PCM (50 ms each)
//   receive  JSON text messages:
//              {type:'Results', is_final, from_finalize?, channel:{alternatives:[{transcript}]}}
//              {type:'Metadata'} and friends — ignored
//   control  {"type":"KeepAlive"} every ~8 s; {"type":"Finalize"} flushes the
//            un-finalized tail (reply arrives flagged from_finalize:true);
//            {"type":"CloseStream"} then close().
//
// Transcript model: Deepgram interleaves progressive interim hypotheses with
// is_final segments. We accumulate is_final transcripts in order; the live
// text at any moment = finals joined + the latest non-final hypothesis. On
// is_final the running hypothesis is cleared — the final supersedes it.
//
// Everything here is fail-soft: the caller (recording-controller) treats any
// rejection as "use the batch pipeline", and the MediaRecorder keeps
// recording in parallel the whole time, so no failure loses audio.

import WebSocket from 'ws'
import log from 'electron-log/main'
import { getAsrToken, asrError } from './asr-token'
import { isAsrWsUrlAllowed } from './security'

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'
// A stream that takes longer than this to open is useless for a dictation —
// the batch path would have been halfway done. ws's handshakeTimeout also
// guarantees the connect promise always settles.
const CONNECT_TIMEOUT_MS = 8_000
// Deepgram closes idle sockets after ~10 s of no audio; with 50 ms frames
// flowing this rarely matters, but a muted/very quiet source can legitimately
// starve the socket, so keep it alive anyway.
const KEEPALIVE_INTERVAL_MS = 8_000
const FINALIZE_TIMEOUT_MS = 2_000
// Quiet-period heuristics for finalize (see finalize() below):
// after an is_final arrives post-Finalize, wait this long for stragglers —
// the flush can deliver more than one final segment back-to-back.
const FLUSH_QUIET_MS = 150
// If NOTHING arrives after sending Finalize, resolve once this idle window
// passes with no un-finalized hypothesis outstanding. Deepgram documents
// that a Finalize with no buffered audio may produce NO reply at all —
// without this, every dictation that ends on a natural pause (everything
// already finalized by endpointing) would burn the full 2 s timeout and
// fall back to batch for no reason. 600 ms and not shorter: a flush reply
// normally lands in 100-300 ms, so a genuinely pending flush racing this
// window (user's last words spoken so close to the hotkey that no interim
// for them exists yet) needs to be >2x slower than typical to lose words.
const FINALIZE_NO_REPLY_MS = 600
// Re-arm window when an interim arrives during finalize: Deepgram is still
// decoding, so its flush final is imminent — check back shortly.
const INTERIM_QUIET_MS = 300
// Close handshakes that hang get the axe — never leak a TLS socket.
const CLOSE_KILL_MS = 3_000

export interface AsrStreamOptions {
  // Streaming is gated to English upstream (recording-controller): Nova-3
  // streaming quality is only validated for en, and the filler-strip stage of
  // the post-pipeline is English-only anyway.
  language: 'en'
  // Fired on EVERY Results message with the full accumulated text (finals +
  // current hypothesis) — the caller broadcasts it to the overlay.
  onInterim: (fullText: string) => void
}

export interface AsrSession {
  /** Forward one 50 ms PCM frame. Silently dropped unless the socket is open
   *  and the session is still streaming — frames racing a finalize/abort are
   *  expected and harmless (the MediaRecorder has the same audio). */
  sendFrame(frame: Buffer): void
  /** Flush Deepgram's tail and resolve the full transcript. Rejects with a
   *  typed AsrError on timeout/socket death — the caller falls back to the
   *  batch pipeline. The socket is closed either way; a session finalizes
   *  at most once. */
  finalize(timeoutMs?: number): Promise<string>
  /** Immediate teardown (sign-out, session invalidated, superseded). Safe to
   *  call at any time, including after finalize settled. */
  abort(): void
}

interface DeepgramResults {
  type?: string
  is_final?: boolean
  from_finalize?: boolean
  channel?: { alternatives?: Array<{ transcript?: string }> }
}

// ws hands text frames back as Buffer (or Buffer[] for fragmented messages);
// normalize before JSON.parse.
function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export function startAsrStream(opts: AsrStreamOptions): Promise<AsrSession> {
  return mintAndConnect(opts)
}

async function mintAndConnect(opts: AsrStreamOptions): Promise<AsrSession> {
  // Mint first (cached ~30 s window makes repeat dictations skip this hop).
  // Throws typed quota/not-configured/mint-failed — caller logs and falls
  // back; the batch path re-surfaces quota to the user on its own.
  const token = await getAsrToken()

  const url = new URL(DEEPGRAM_WS_URL)
  url.searchParams.set('model', 'nova-3')
  url.searchParams.set('encoding', 'linear16')
  url.searchParams.set('sample_rate', '16000')
  url.searchParams.set('channels', '1')
  url.searchParams.set('smart_format', 'true')
  // Spoken punctuation at the engine ("period" → ".", "new paragraph" →
  // break) — Wispr-parity with zero added latency. The LLM format pass has
  // the same rule for the batch path, so both engines converge on one
  // behavior; on this path the command usually never reaches the LLM at all.
  url.searchParams.set('dictation', 'true')
  url.searchParams.set('interim_results', 'true')
  url.searchParams.set('language', opts.language)
  const wsUrl = url.toString()
  // Belt + braces: the URL is built from constants two lines up, but this is
  // the choke point where raw mic audio + a grant token leave the machine —
  // same defense-in-depth stance as isProxyUrlAllowed on the HTTP side.
  if (!isAsrWsUrlAllowed(wsUrl)) {
    throw asrError('connect-failed', 'ASR WebSocket URL is not allowed.')
  }

  const tConnect = Date.now()
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    // 1.6 kB binary frames every 50 ms — compression would add latency and
    // CPU for zero win on already-incompressible PCM.
    perMessageDeflate: false,
  })

  // ── Closure-owned session state ───────────────────────────────────────────
  type State = 'connecting' | 'streaming' | 'finalizing' | 'closed'
  let state: State = 'connecting'
  const finals: string[] = []
  let interim = ''
  let tOpen = 0
  let tFinalize = 0
  let firstResultLogged = false
  let framesSent = 0
  let keepAliveTimer: NodeJS.Timeout | null = null
  let finalizeTimer: NodeJS.Timeout | null = null
  let quietTimer: NodeJS.Timeout | null = null
  let finalizeSettle: { resolve: (text: string) => void; reject: (err: Error) => void } | null =
    null

  const joined = (): string => {
    const parts = finals.slice()
    // A leftover hypothesis is audio Deepgram heard but never finalized —
    // better to include the best guess than to silently drop trailing words.
    if (interim) parts.push(interim)
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  const clearTimers = (): void => {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null }
    if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null }
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
  }

  // One-way door: after teardown the session is inert — no timers, no
  // listeners, no state transitions. Every settle path funnels through here
  // so a late socket event can never fire a dangling callback.
  const teardown = (): void => {
    state = 'closed'
    clearTimers()
    ws.removeAllListeners()
  }

  const closeGracefully = (): void => {
    try { ws.send('{"type":"CloseStream"}') } catch { /* socket may be dead */ }
    try { ws.close() } catch { /* ignore */ }
    // If the close handshake never completes (half-dead network), terminate.
    const killer = setTimeout(() => {
      try { ws.terminate() } catch { /* ignore */ }
    }, CLOSE_KILL_MS)
    killer.unref?.()
  }

  const settleResolve = (): void => {
    const settle = finalizeSettle
    finalizeSettle = null
    log.info(
      `[timing] asr finalize-rtt ${Date.now() - tFinalize}ms ` +
        `(finals=${finals.length}, framesSent=${framesSent})`,
    )
    const text = joined()
    teardown()
    closeGracefully()
    settle?.resolve(text)
  }

  const settleReject = (err: Error): void => {
    const settle = finalizeSettle
    finalizeSettle = null
    teardown()
    closeGracefully()
    settle?.reject(err)
  }

  // Quiet timer: resolves the finalize once messages stop arriving AND no
  // un-finalized hypothesis is outstanding. If a hypothesis IS outstanding,
  // the flush final for it is still in flight — re-arm and keep waiting
  // (the overall finalize timeout is the backstop).
  const armQuiet = (ms: number): void => {
    if (quietTimer) clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (state !== 'finalizing') return
      if (interim) {
        armQuiet(INTERIM_QUIET_MS)
        return
      }
      settleResolve()
    }, ms)
  }

  const handleMessage = (data: WebSocket.RawData): void => {
    let msg: DeepgramResults
    try {
      msg = JSON.parse(rawDataToString(data)) as DeepgramResults
    } catch {
      return // binary or malformed frame — Deepgram only sends JSON text
    }
    // Metadata / UtteranceEnd / SpeechStarted are irrelevant to transcript
    // assembly — only Results carries words.
    if (msg.type !== 'Results') return

    if (!firstResultLogged) {
      firstResultLogged = true
      log.info(`[timing] asr first-result ${Date.now() - tOpen}ms`)
    }

    const transcript = (msg.channel?.alternatives?.[0]?.transcript ?? '').trim()
    if (msg.is_final) {
      if (transcript) finals.push(transcript)
      interim = '' // the final supersedes the running hypothesis
    } else {
      interim = transcript
    }

    try {
      opts.onInterim(joined())
    } catch (err) {
      log.warn('[asr] onInterim callback threw', err)
    }

    if (state === 'finalizing') {
      if (msg.from_finalize) {
        // The explicit flush confirmation — done.
        settleResolve()
      } else if (msg.is_final) {
        // A final without the flag: either an in-flight segment final or a
        // flush whose flag is absent (observed variance) — treat it as the
        // flush after a short quiet period so back-to-back finals all land.
        armQuiet(FLUSH_QUIET_MS)
      } else {
        // Still decoding (interim during flush) — keep waiting.
        armQuiet(INTERIM_QUIET_MS)
      }
    }
  }

  const session: AsrSession = {
    sendFrame(frame: Buffer): void {
      // Deliberately also drops frames once finalizing: Finalize marks the
      // cut point, and audio sent after it would open a NEW segment whose
      // final could be mistaken for the flush. The trailing ≤60 ms this
      // drops is covered by the always-running MediaRecorder.
      if (state !== 'streaming' || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(frame)
        framesSent++
      } catch {
        // A send that throws means the socket is dying; the close/error
        // handlers will mark the session dead — dropping this frame is fine.
      }
    },

    finalize(timeoutMs = FINALIZE_TIMEOUT_MS): Promise<string> {
      if (state !== 'streaming' || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          asrError('ws-error', `socket not open at finalize (state=${state})`),
        )
      }
      state = 'finalizing'
      tFinalize = Date.now()
      return new Promise<string>((resolve, reject) => {
        finalizeSettle = { resolve, reject }
        finalizeTimer = setTimeout(() => {
          settleReject(asrError('finalize-timeout', `no flush final within ${timeoutMs}ms`))
        }, timeoutMs)
        // Arm the no-reply window immediately: if everything was already
        // finalized by endpointing, Deepgram may never reply to Finalize at
        // all (documented) — resolve from what we hold instead of timing out.
        armQuiet(FINALIZE_NO_REPLY_MS)
        try {
          ws.send('{"type":"Finalize"}')
        } catch (err) {
          settleReject(asrError('ws-error', `Finalize send failed: ${(err as Error).message}`))
        }
      })
    },

    abort(): void {
      if (state === 'closed') return
      log.info('[asr] session aborted')
      settleReject(asrError('aborted', 'ASR session aborted'))
      // settleReject close-handshakes; an abort wants the socket GONE now
      // (sign-out must not leave audio-capable sockets lingering).
      try { ws.terminate() } catch { /* ignore */ }
    },
  }

  return new Promise<AsrSession>((resolve, reject) => {
    ws.on('open', () => {
      tOpen = Date.now()
      state = 'streaming'
      log.info(`[timing] asr ws-connect ${tOpen - tConnect}ms`)
      keepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send('{"type":"KeepAlive"}') } catch { /* close handler owns errors */ }
        }
      }, KEEPALIVE_INTERVAL_MS)
      keepAliveTimer.unref?.()
      resolve(session)
    })

    ws.on('message', handleMessage)

    // One error handler for both phases: pre-open failures (DNS, TLS, 4xx
    // upgrade rejection, handshake timeout) reject the connect promise;
    // post-open failures kill the session so a pending finalize falls back.
    ws.on('error', (err: Error) => {
      if (state === 'connecting') {
        teardown()
        try { ws.terminate() } catch { /* ignore */ }
        reject(asrError('connect-failed', `ASR connect failed: ${err.message}`))
        return
      }
      if (state === 'closed') return
      log.warn(`[asr] socket error mid-session: ${err.message}`)
      settleReject(asrError('ws-error', `socket error: ${err.message}`))
      try { ws.terminate() } catch { /* ignore */ }
    })

    ws.on('close', (code: number) => {
      if (state === 'closed') return // our own teardown — expected
      if (state === 'connecting') {
        teardown()
        reject(asrError('connect-failed', `socket closed during connect (code=${code})`))
        return
      }
      // Server-side close mid-stream (idle timeout, token expiry, deploy).
      // A live recording keeps going on the batch path — the controller
      // finds out when finalize() rejects (or immediately, if one is pending).
      log.warn(`[asr] socket closed mid-session code=${code} (state=${state})`)
      settleReject(asrError('ws-error', `socket closed mid-session (code=${code})`))
    })
  })
}
