// @vitest-environment happy-dom
import { COLLECTION_REVISION_KEY } from "@megaui/core";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  readCollectionRevision,
  useChannelCollectionRoom,
} from "./use-collection-room";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("readCollectionRevision (RT-08)", () => {
  it("returns a revision when the Y.Map is complete and null otherwise", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>(COLLECTION_REVISION_KEY);
    expect(readCollectionRevision(map)).toBeNull();
    map.set("kind", "edit");
    map.set("messageId", "msg-1");
    map.set("at", 42);
    expect(readCollectionRevision(map)).toEqual({
      kind: "edit",
      messageId: "msg-1",
      at: 42,
    });
    map.set("at", "nope");
    expect(readCollectionRevision(map)).toBeNull();
  });

  it("notifies observers when the revision map changes", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>(COLLECTION_REVISION_KEY);
    const seen: Array<ReturnType<typeof readCollectionRevision>> = [];
    const observer = () => {
      seen.push(readCollectionRevision(map));
    };
    map.observe(observer);
    map.set("kind", "reaction");
    map.set("messageId", "msg-2");
    map.set("at", 9);
    expect(seen.at(-1)).toEqual({ kind: "reaction", messageId: "msg-2", at: 9 });
    map.unobserve(observer);
  });
});

describe("useChannelCollectionRoom local mode (RT-08)", () => {
  it("no-ops when the collab URL is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL", "");
    function Probe() {
      const room = useChannelCollectionRoom({
        channelId: "chn-1",
        token: "ticket",
        enabled: true,
      });
      return createElement(
        "div",
        null,
        `${String(room.connected)}|${room.childIds.length}|${room.revision ? "rev" : "none"}`,
      );
    }
    const { container } = render(createElement(Probe));
    expect(container.textContent).toBe("false|0|none");
  });
});
