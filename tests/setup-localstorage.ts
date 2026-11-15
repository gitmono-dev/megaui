/**
 * Node 25+ exposes `window.localStorage` only when `--localstorage-file`
 * is set; otherwise the getter is undefined and happy-dom persistence
 * tests crash. Install an in-memory Storage only when the host left it
 * missing (CI Node 24 / real browsers are unchanged).
 */
if (typeof window !== "undefined" && window.localStorage == null) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}
