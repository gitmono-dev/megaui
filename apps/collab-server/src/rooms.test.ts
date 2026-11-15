import { describe, expect, it } from "vitest";

import { parseRoomName } from "./rooms";

describe("parseRoomName (CS-01 + RT-02)", () => {
  it("parses container:doc:{id}", () => {
    expect(parseRoomName("container:doc:abc-123")).toEqual({
      kind: "container",
      containerType: "doc",
      containerId: "abc-123",
      documentName: "container:doc:abc-123",
    });
  });

  it("parses collection:channel:{id}", () => {
    expect(parseRoomName("collection:channel:abc")).toEqual({
      kind: "collection",
      collectionType: "channel",
      collectionId: "abc",
      documentName: "collection:channel:abc",
    });
  });

  it("rejects inbox/doc collection, container:channel, and unknown patterns", () => {
    expect(parseRoomName("collection:inbox:user-1")).toBeNull();
    expect(parseRoomName("collection:doc:abc")).toBeNull();
    expect(parseRoomName("container:channel:abc")).toBeNull();
    expect(parseRoomName("")).toBeNull();
    expect(parseRoomName("container:doc:")).toBeNull();
    expect(parseRoomName("collection:channel:")).toBeNull();
  });
});
