/**
 * megaui:libs/mega/collab/container.ts@0ff3a9d
 *
 * Content room naming: `container:{type}:{id}`.
 * Shared by the collab server and its clients.
 */

export const CONTAINER_ROOM_PREFIX = 'container:' as const
export const CONTAINER_TYPE_DOC = 'doc' as const

export function buildContainerRoomName(containerType: string, containerId: string): string {
  return `${CONTAINER_ROOM_PREFIX}${containerType}:${containerId}`
}

export function buildDocContainerRoomName(docId: string): string {
  return buildContainerRoomName(CONTAINER_TYPE_DOC, docId)
}

/**
 * megaui:libs/mega/collab/collection.ts@af4455a
 *
 * B-type collection room naming: `collection:{type}:{id}`.
 * This repo only opens `collection:channel:{id}` (ADR-RT-01 / RT-02).
 * inbox/doc collection types stay unexported as constructible kinds here so
 * callers cannot accidentally mint rooms the server will reject.
 */
export const COLLECTION_ROOM_PREFIX = 'collection:' as const
export const COLLECTION_TYPE_CHANNEL = 'channel' as const
export const COLLECTION_CHILD_IDS_KEY = 'childIds' as const
export const COLLECTION_REVISION_KEY = 'revision' as const

export function buildCollectionRoomName(collectionType: string, collectionId: string): string {
  return `${COLLECTION_ROOM_PREFIX}${collectionType}:${collectionId}`
}

export function buildChannelCollectionRoomName(channelId: string): string {
  return buildCollectionRoomName(COLLECTION_TYPE_CHANNEL, channelId)
}

/** Returns the channel id or null when the room is not `collection:channel:{id}`. */
export function parseCollectionChannelRoomName(roomName: string): string | null {
  const trimmed = roomName.trim()
  const prefix = `${COLLECTION_ROOM_PREFIX}${COLLECTION_TYPE_CHANNEL}:`
  if (!trimmed.startsWith(prefix)) return null
  const id = trimmed.slice(prefix.length).trim()
  if (!id || id.includes('/') || id.includes(':')) return null
  return id
}
