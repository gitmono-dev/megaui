/**
 * A-type content rooms: `container:doc:{id}` (ADR-ARCH-08 / CS-01).
 * B-type chat hint rooms: `collection:channel:{id}` (ADR-RT-01 / RT-02).
 * inbox/doc collection and unknown patterns stay fail-closed.
 */

import {
  COLLECTION_ROOM_PREFIX,
  COLLECTION_TYPE_CHANNEL,
  CONTAINER_ROOM_PREFIX,
  CONTAINER_TYPE_DOC,
} from "@megaui/core";

export interface ContainerDocRoom {
  kind: "container";
  containerType: typeof CONTAINER_TYPE_DOC;
  containerId: string;
  documentName: string;
}

export interface CollectionChannelRoom {
  kind: "collection";
  collectionType: typeof COLLECTION_TYPE_CHANNEL;
  collectionId: string;
  documentName: string;
}

export type ParsedRoom = ContainerDocRoom | CollectionChannelRoom;

function parseTypeAndId(rest: string): { type: string; id: string } | null {
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const type = rest.slice(0, colon).trim();
  const id = rest.slice(colon + 1).trim();
  if (!type || !id) return null;
  if (type.includes("/") || id.includes("/")) return null;
  return { type, id };
}

/**
 * Parse a supported room name. Returns null for unknown patterns (fail-closed).
 */
export function parseRoomName(documentName: string): ParsedRoom | null {
  const trimmed = documentName.trim();

  if (trimmed.startsWith(COLLECTION_ROOM_PREFIX)) {
    const parsed = parseTypeAndId(trimmed.slice(COLLECTION_ROOM_PREFIX.length));
    if (!parsed || parsed.type !== COLLECTION_TYPE_CHANNEL) return null;
    return {
      kind: "collection",
      collectionType: COLLECTION_TYPE_CHANNEL,
      collectionId: parsed.id,
      documentName: trimmed,
    };
  }

  if (!trimmed.startsWith(CONTAINER_ROOM_PREFIX)) return null;
  const parsed = parseTypeAndId(trimmed.slice(CONTAINER_ROOM_PREFIX.length));
  if (!parsed || parsed.type !== CONTAINER_TYPE_DOC) return null;
  return {
    kind: "container",
    containerType: CONTAINER_TYPE_DOC,
    containerId: parsed.id,
    documentName: trimmed,
  };
}

export function isContainerDocRoom(room: ParsedRoom): room is ContainerDocRoom {
  return room.kind === "container";
}

export function isCollectionChannelRoom(room: ParsedRoom): room is CollectionChannelRoom {
  return room.kind === "collection";
}
