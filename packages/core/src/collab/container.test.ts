import { describe, expect, it } from 'vitest'
import {
  buildChannelCollectionRoomName,
  buildCollectionRoomName,
  buildContainerRoomName,
  buildDocContainerRoomName,
  COLLECTION_ROOM_PREFIX,
  COLLECTION_TYPE_CHANNEL,
  CONTAINER_ROOM_PREFIX,
  CONTAINER_TYPE_DOC,
  parseCollectionChannelRoomName,
} from './container'

describe('buildContainerRoomName', () => {
  it('joins prefix, type and id with colons', () => {
    expect(buildContainerRoomName('doc', 'abc123')).toBe(`${CONTAINER_ROOM_PREFIX}doc:abc123`)
  })
})

describe('buildDocContainerRoomName', () => {
  it('uses the doc container type constant', () => {
    expect(buildDocContainerRoomName('doc-1')).toBe(buildContainerRoomName(CONTAINER_TYPE_DOC, 'doc-1'))
  })
})

describe('buildCollectionRoomName (RT-02)', () => {
  it('joins the collection prefix, channel type and id', () => {
    expect(buildCollectionRoomName(COLLECTION_TYPE_CHANNEL, 'abc')).toBe(
      `${COLLECTION_ROOM_PREFIX}${COLLECTION_TYPE_CHANNEL}:abc`,
    )
    expect(buildChannelCollectionRoomName('abc')).toBe('collection:channel:abc')
  })

  it('parses only collection:channel rooms', () => {
    expect(parseCollectionChannelRoomName('collection:channel:abc')).toBe('abc')
    expect(parseCollectionChannelRoomName('collection:inbox:user-1')).toBeNull()
    expect(parseCollectionChannelRoomName('collection:doc:abc')).toBeNull()
    expect(parseCollectionChannelRoomName('container:doc:abc')).toBeNull()
  })
})
