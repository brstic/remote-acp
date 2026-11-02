// Node >= 25 ships a global `localStorage` that shadows jsdom's; use an in-memory one.
const store = new Map<string, string>();
const mem: Storage = {
  get length() { return store.size; },
  clear: () => store.clear(),
  getItem: (k) => store.get(k) ?? null,
  key: (i) => [...store.keys()][i] ?? null,
  removeItem: (k) => void store.delete(k),
  setItem: (k, v) => void store.set(k, String(v)),
};
Object.defineProperty(globalThis, "localStorage", { value: mem, configurable: true });
Object.defineProperty(window, "localStorage", { value: mem, configurable: true });
