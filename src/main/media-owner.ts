export type MediaOwner = 'dictation' | 'flowcast'

let owner: MediaOwner | null = null

export function tryAcquireMedia(next: MediaOwner): boolean {
  if (owner && owner !== next) return false
  owner = next
  return true
}

export function releaseMedia(expected: MediaOwner): void {
  if (owner === expected) owner = null
}

export function getMediaOwner(): MediaOwner | null {
  return owner
}
