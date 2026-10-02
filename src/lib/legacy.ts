// MIGRATION SHIM — browser settings from before the product was renamed.
//
// Theme, source, LLM settings, chat and assistant history used to be stored
// under `kalam_*` keys. On first load after the rename each one is moved to
// its `trinetra_*` name (an existing new key always wins), so nobody loses
// their settings. This is the only place in the UI that knows the old name.

const OLD_PREFIX = 'kalam_';
const NEW_PREFIX = 'trinetra_';

export function migrateLegacyStorage(store: Storage | undefined = globalThis.localStorage): number {
  if (!store) return 0;
  let moved = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(OLD_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const next = NEW_PREFIX + k.slice(OLD_PREFIX.length);
      const v = store.getItem(k);
      if (v !== null && store.getItem(next) === null) store.setItem(next, v);
      store.removeItem(k);
      moved++;
    }
  } catch {
    // Storage disabled or full: the app runs on defaults.
  }
  return moved;
}
