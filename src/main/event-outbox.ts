import { app, safeStorage } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { REVISION16_CONTRACT } from '../generated/revision16-contract'

const MAX_AGE_MS = REVISION16_CONTRACT.metering.desktopOutboxRetentionDays * 24 * 60 * 60 * 1000
const MAX_EVENTS_PER_OWNER = 500

export interface UsageOutboxEvent {
  id: string
  ownerId: string
  clientEventId: string
  text: string
  audioSeconds: number
  durationSeconds: number
  engine: string
  source: 'local' | 'streaming' | 'dictation'
  appContext: string | null
  deletionGeneration: number
  createdAt: number
}

interface OwnerEnvelope {
  version: 1
  ownerId: string
  deletionGeneration: number
  events: UsageOutboxEvent[]
}

const locks = new Map<string, Promise<unknown>>()

function withOwnerLock<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(ownerId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  locks.set(ownerId, next)
  return next.finally(() => {
    if (locks.get(ownerId) === next) locks.delete(ownerId)
  })
}

function ownerFile(ownerId: string): string {
  const digest = createHash('sha256').update(ownerId, 'utf8').digest('hex')
  return path.join(app.getPath('userData'), 'outbox-v2', `${digest}.enc`)
}

function empty(ownerId: string): OwnerEnvelope {
  return { version: 1, ownerId, deletionGeneration: 0, events: [] }
}

function encryptionReady(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function prune(envelope: OwnerEnvelope, now = Date.now()): OwnerEnvelope {
  envelope.events = envelope.events
    .filter((event) => now - event.createdAt <= MAX_AGE_MS)
    .slice(-MAX_EVENTS_PER_OWNER)
  return envelope
}

async function loadUnlocked(ownerId: string): Promise<OwnerEnvelope> {
  if (!encryptionReady()) return empty(ownerId)
  try {
    const encoded = await readFile(ownerFile(ownerId), 'utf8')
    const plaintext = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    const parsed = JSON.parse(plaintext) as OwnerEnvelope
    if (parsed.version !== 1 || parsed.ownerId !== ownerId || !Array.isArray(parsed.events)) {
      return empty(ownerId)
    }
    return prune(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(ownerId)
    return empty(ownerId)
  }
}

async function saveUnlocked(envelope: OwnerEnvelope): Promise<void> {
  if (!encryptionReady()) throw new Error('secure-storage-unavailable')
  const file = ownerFile(envelope.ownerId)
  await mkdir(path.dirname(file), { recursive: true })
  const ciphertext = safeStorage.encryptString(JSON.stringify(prune(envelope))).toString('base64')
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, ciphertext, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

export async function getDeletionGeneration(ownerId: string): Promise<number> {
  return withOwnerLock(ownerId, async () => (await loadUnlocked(ownerId)).deletionGeneration)
}

export async function enqueueUsageEvent(event: UsageOutboxEvent): Promise<boolean> {
  if (!encryptionReady()) return false
  return withOwnerLock(event.ownerId, async () => {
    const envelope = await loadUnlocked(event.ownerId)
    if (event.deletionGeneration !== envelope.deletionGeneration) return false
    const existing = envelope.events.find((candidate) => candidate.clientEventId === event.clientEventId)
    if (!existing) envelope.events.push(event)
    await saveUnlocked(envelope)
    return true
  })
}

export async function flushUsageEvents(
  ownerId: string,
  submit: (event: UsageOutboxEvent) => Promise<boolean>,
): Promise<UsageOutboxEvent[]> {
  if (!encryptionReady()) return []
  return withOwnerLock(ownerId, async () => {
    const envelope = await loadUnlocked(ownerId)
    const completed: UsageOutboxEvent[] = []
    const remaining: UsageOutboxEvent[] = []
    for (const event of envelope.events) {
      if (event.deletionGeneration !== envelope.deletionGeneration) continue
      if (await submit(event)) completed.push(event)
      else remaining.push(event)
    }
    envelope.events = remaining
    await saveUnlocked(envelope)
    return completed
  })
}

/** Hold the owner lock through the entire purge and generation update. */
export async function purgeOwnerOutbox(ownerId: string, deletionGeneration: number): Promise<void> {
  if (!Number.isSafeInteger(deletionGeneration) || deletionGeneration < 0) {
    throw new Error('invalid-deletion-generation')
  }
  await withOwnerLock(ownerId, async () => {
    const envelope = await loadUnlocked(ownerId)
    envelope.deletionGeneration = Math.max(envelope.deletionGeneration, deletionGeneration)
    envelope.events = []
    if (encryptionReady()) await saveUnlocked(envelope)
    else await unlink(ownerFile(ownerId)).catch(() => undefined)
  })
}
