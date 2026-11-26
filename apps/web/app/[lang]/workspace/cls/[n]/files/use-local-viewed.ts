"use client";

import { useCallback, useEffect, useState } from "react";

interface ViewedScope {
  actorId: string;
  publicId: string;
  revision: string;
  range: string;
}

const empty: ReadonlySet<string> = new Set();
const localChange = "megaui:cl-viewed-changed";

export function useLocalViewed(scope: ViewedScope | undefined) {
  const prefix = scope?.actorId && scope.publicId && scope.revision
    ? `megaui:cl-viewed:v1:${JSON.stringify([scope.actorId, scope.publicId, scope.revision, scope.range])}:`
    : undefined;
  const [snapshot, setSnapshot] = useState<{ prefix: string; paths: ReadonlySet<string> }>();

  useEffect(() => {
    if (!prefix) return;
    const sync = (key: string | null) => {
      if (key !== null && !key.startsWith(prefix)) return;
      try {
        const storage = window.localStorage;
        if (key === null) {
          const paths = new Set<string>();
          for (let i = 0, count = storage.length; i < count; i++) {
            const entry = storage.key(i);
            if (entry?.startsWith(prefix) && storage.getItem(entry) === "1") paths.add(entry.slice(prefix.length));
          }
          setSnapshot({ prefix, paths });
        } else {
          // Re-read the key so a queued notification cannot restore a stale value.
          const path = key.slice(prefix.length);
          const viewed = storage.getItem(key) === "1";
          setSnapshot((previous) => {
            const current = previous?.prefix === prefix ? previous.paths : empty;
            if (current.has(path) === viewed) return previous;
            const paths = new Set(current);
            if (viewed) paths.add(path);
            else paths.delete(path);
            return { prefix, paths };
          });
        }
      } catch {
        setSnapshot(undefined);
      }
    };
    const external = (event: StorageEvent) => sync(event.key);
    const local = (event: Event) => sync((event as CustomEvent<string>).detail);
    window.addEventListener("storage", external);
    window.addEventListener(localChange, local);
    sync(null);
    return () => {
      window.removeEventListener("storage", external);
      window.removeEventListener(localChange, local);
    };
  }, [prefix]);

  const setViewed = useCallback((path: string, viewed: boolean) => {
    if (!prefix || !path) return false;
    const key = prefix + path;
    try {
      // Each file has its own key, so writes from different tabs cannot replace one another.
      if (viewed) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch {
      return false;
    }
    window.dispatchEvent(new CustomEvent<string>(localChange, { detail: key }));
    return true;
  }, [prefix]);

  return { paths: snapshot && snapshot.prefix === prefix ? snapshot.paths : empty, setViewed };
}
