import Store from 'electron-store'
import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { defaultPreferences, validatePreferences, type DictationPreferences } from './dictation-preferences'

export interface ReviewEntry {
  id: string; at: number; original: string; output: string; app: string | null
  truncated?: boolean; pasted: boolean; totalMs: number; formatMs: number; mode: string
}
interface OwnerData { preferences: DictationPreferences; corrections: { from: string; to: string }[]; reviews: ReviewEntry[] }
const store = new Store<{ owners: Record<string, string> }>({ name: 'dictation-review', defaults: { owners: {} } })
const empty = (): OwnerData => ({ preferences: { ...defaultPreferences }, corrections: [], reviews: [] })
function read(owner: string | null): OwnerData {
  if (!owner || !safeStorage.isEncryptionAvailable()) return empty()
  try {
    const encoded = store.get('owners')[owner]
    if (!encoded) return empty()
    const data = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64'))) as OwnerData
    const fresh = (data.reviews ?? []).filter(r => Date.now() - r.at < 86_400_000).slice(-100)
    if (fresh.length !== data.reviews?.length) { data.reviews = fresh; write(owner, data) }
    return { preferences: validatePreferences(data.preferences) ?? { ...defaultPreferences }, corrections: data.corrections ?? [],
      reviews: fresh }
  } catch { return empty() }
}
function write(owner: string, data: OwnerData): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable')
  store.set('owners', { ...store.get('owners'), [owner]: safeStorage.encryptString(JSON.stringify(data)).toString('base64') })
}
export function getDictationPreferences(owner: string | null): DictationPreferences { return read(owner).preferences }
export function getDictationReview(owner: string) { const d = read(owner); return { ...d, reviews: [...d.reviews].reverse() } }
export function saveDictationPreferences(owner: string, preferences: DictationPreferences): void {
  const data = read(owner); data.preferences = preferences
  if (!preferences.retainOriginals) data.reviews = []
  write(owner, data)
}
export function rememberCorrection(owner: string, from: string, to: string): void {
  if (!from.trim() || !to.trim() || from.length > 100 || to.length > 100 || /[\r\n]/.test(from + to)) throw new Error('Use a word or short phrase, up to 100 characters')
  const d = read(owner)
  d.corrections = [...d.corrections.filter(c => c.from.toLocaleLowerCase() !== from.trim().toLocaleLowerCase()), { from: from.trim(), to: to.trim() }].slice(-200)
  write(owner, d)
}
export function forgetCorrection(owner: string, from: string): void { const d = read(owner); d.corrections = d.corrections.filter(c => c.from !== from); write(owner, d) }
export function getCorrections(owner: string | null) { return read(owner).corrections }
export function saveDictationReview(owner: string, entry: Omit<ReviewEntry, 'id' | 'at'>): void {
  const data = read(owner)
  if (!data.preferences.retainOriginals) return
  data.reviews = [...data.reviews, { ...entry, truncated: entry.original.length > 30000 || entry.output.length > 30000, original: entry.original.slice(0, 30000), output: entry.output.slice(0, 30000), id: randomUUID(), at: Date.now() }].slice(-100)
  write(owner, data)
}
export function clearDictationReviews(owner: string, id?: string): void { const d = read(owner); d.reviews = id ? d.reviews.filter(r => r.id !== id) : []; write(owner, d) }

// Expire encrypted comparison text while the app remains open.
const expiry = setInterval(() => { for (const owner of Object.keys(store.get('owners'))) read(owner) }, 60_000)
expiry.unref()
