export type CartPersistence = "saved" | "memory" | "loading";

export type CartStoreSnapshot<T> = {
  draft: T;
  persistence: CartPersistence;
};

export type CartStorage = {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
};

type StorageEventLike = {
  key: string | null;
  storageArea?: unknown;
};

export type StorageEventTargetLike = {
  addEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
};

type CartStoreCoreOptions<T> = {
  getStorage: () => CartStorage | null | undefined;
  getEventTarget?: () => StorageEventTargetLike | null | undefined;
  emptyDraft: () => T;
  sanitizeDraft: (value: unknown) => T | null;
  storagePrefix: string;
  storageRoot?: string;
  maxBytes?: number;
};

type Slot<T> = {
  snapshot: CartStoreSnapshot<T>;
  hydrated: boolean;
};

const MAX_SCOPE_CHARS = 256;
const DEFAULT_MAX_BYTES = 16 * 1024;

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Browser-independent scoped storage core; React adapter owns hydration timing. */
export class CartStoreCore<T> {
  private readonly slots = new Map<string, Slot<T>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly loadingSnapshot: CartStoreSnapshot<T>;
  private readonly storageListener = (event: StorageEventLike) => {
    try {
      const currentStorage = this.options.getStorage();
      if (event.storageArea && currentStorage && event.storageArea !== currentStorage) return;
    } catch {
      // The storage adapter will report the unavailable state during refresh.
    }
    this.handleStorageChange(event.key);
  };
  private attachedTarget: StorageEventTargetLike | null = null;
  private readonly options: CartStoreCoreOptions<T>;

  constructor(options: CartStoreCoreOptions<T>) {
    this.options = options;
    this.loadingSnapshot = { draft: options.emptyDraft(), persistence: "loading" };
  }

  snapshot(scope: string | null): CartStoreSnapshot<T> {
    if (!this.isValidScope(scope)) return this.loadingSnapshot;
    return this.getSlot(scope).snapshot;
  }

  subscribe(scope: string | null, listener: () => void): () => void {
    if (!this.isValidScope(scope)) return () => undefined;
    let scopedListeners = this.listeners.get(scope);
    if (!scopedListeners) {
      scopedListeners = new Set();
      this.listeners.set(scope, scopedListeners);
    }
    scopedListeners.add(listener);
    this.syncStorageListener();
    return () => {
      const current = this.listeners.get(scope);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(scope);
      this.syncStorageListener();
    };
  }

  hydrate(scope: string | null): void {
    if (!this.isValidScope(scope)) return;
    const slot = this.getSlot(scope);
    if (slot.hydrated && slot.snapshot.persistence === "memory") return;
    this.refreshScope(scope, true);
  }

  save(scope: string | null, draft: unknown): void {
    if (!this.isValidScope(scope)) return;
    const slot = this.getSlot(scope);
    if (!slot.hydrated) return;

    const safeDraft = this.options.sanitizeDraft(draft);
    if (safeDraft === null) return;

    const envelope = { version: 1, scope, draft: safeDraft };
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
      if (utf8ByteLength(serialized) > this.maxBytes) return;
    } catch {
      return;
    }

    let persistence: CartPersistence = "memory";
    try {
      const storage = this.options.getStorage();
      if (storage) {
        storage.setItem(this.storageKey(scope), serialized);
        persistence = "saved";
      }
    } catch {
      persistence = "memory";
    }
    this.update(scope, slot, safeDraft, persistence, true);
  }

  clear(scope: string | null): void {
    if (!this.isValidScope(scope)) return;
    const slot = this.getSlot(scope);
    if (!slot.hydrated) return;

    let persistence: CartPersistence = "memory";
    try {
      const storage = this.options.getStorage();
      if (storage) {
        storage.removeItem(this.storageKey(scope));
        persistence = "saved";
      }
    } catch {
      persistence = "memory";
    }
    this.update(scope, slot, this.options.emptyDraft(), persistence, true);
  }

  /** Clear all versions and scopes at an authentication or invitation boundary. */
  resetAll(): void {
    let persistence: CartPersistence = "memory";
    try {
      const storage = this.options.getStorage();
      if (storage) {
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(this.storageRoot)) keys.push(key);
        }
        persistence = "saved";
        for (const key of keys) {
          try {
            storage.removeItem(key);
          } catch {
            persistence = "memory";
          }
        }
      }
    } catch {
      persistence = "memory";
    }

    for (const [scope, slot] of this.slots) {
      this.update(scope, slot, this.options.emptyDraft(), persistence, true);
    }
  }

  /** Re-read current localStorage value; event.newValue can already be stale. */
  handleStorageChange(key: string | null): void {
    if (key === null) {
      for (const [scope, slot] of this.slots) {
        if (slot.hydrated) this.refreshScope(scope, true);
      }
      return;
    }
    if (!key.startsWith(this.options.storagePrefix)) return;
    let encodedScope = key.slice(this.options.storagePrefix.length);
    try {
      encodedScope = decodeURIComponent(encodedScope);
    } catch {
      return;
    }
    if (!this.isValidScope(encodedScope)) return;
    const slot = this.slots.get(encodedScope);
    if (slot?.hydrated) this.refreshScope(encodedScope, true);
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private get storageRoot(): string {
    return this.options.storageRoot ?? this.options.storagePrefix;
  }

  private isValidScope(scope: string | null): scope is string {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_SCOPE_CHARS) return false;
    try {
      encodeURIComponent(scope);
      return true;
    } catch {
      return false;
    }
  }

  private storageKey(scope: string): string {
    return `${this.options.storagePrefix}${encodeURIComponent(scope)}`;
  }

  private getSlot(scope: string): Slot<T> {
    let slot = this.slots.get(scope);
    if (!slot) {
      slot = { snapshot: { draft: this.options.emptyDraft(), persistence: "loading" }, hydrated: false };
      this.slots.set(scope, slot);
    }
    return slot;
  }

  private refreshScope(scope: string, force: boolean): void {
    const slot = this.getSlot(scope);
    if (!force && slot.hydrated) return;

    const previousDraft = slot.hydrated ? slot.snapshot.draft : this.options.emptyDraft();
    const emptyDraft = this.options.emptyDraft();
    try {
      const storage = this.options.getStorage();
      if (!storage) {
        this.update(scope, slot, previousDraft, "memory", true);
        return;
      }
      const serialized = storage.getItem(this.storageKey(scope));
      if (serialized === null) {
        this.update(scope, slot, emptyDraft, "saved", true);
        return;
      }
      if (utf8ByteLength(serialized) > this.maxBytes) {
        this.discardStoredValue(scope, slot, storage, emptyDraft);
        return;
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(serialized);
      } catch {
        this.discardStoredValue(scope, slot, storage, emptyDraft);
        return;
      }

      if (
        !isRecord(envelope) ||
        Object.keys(envelope).sort().join(",") !== "draft,scope,version" ||
        envelope.version !== 1 ||
        envelope.scope !== scope
      ) {
        this.discardStoredValue(scope, slot, storage, emptyDraft);
        return;
      }
      const safeDraft = this.options.sanitizeDraft(envelope.draft);
      if (safeDraft === null) {
        this.discardStoredValue(scope, slot, storage, emptyDraft);
        return;
      }
      this.update(scope, slot, safeDraft, "saved", true);
    } catch {
      // Access denied, quota errors, or read/remove failures become memory-only.
      this.update(scope, slot, previousDraft, "memory", true);
    }
  }

  private discardStoredValue(
    scope: string,
    slot: Slot<T>,
    storage: CartStorage,
    emptyDraft: T,
  ): void {
    let persistence: CartPersistence = "saved";
    try {
      storage.removeItem(this.storageKey(scope));
    } catch {
      persistence = "memory";
    }
    this.update(scope, slot, emptyDraft, persistence, true);
  }

  private update(
    scope: string,
    slot: Slot<T>,
    draft: T,
    persistence: CartPersistence,
    hydrated: boolean,
  ): void {
    slot.snapshot = { draft, persistence };
    slot.hydrated = hydrated;
    for (const listener of this.listeners.get(scope) ?? []) listener();
  }

  private syncStorageListener(): void {
    let hasListeners = false;
    for (const scopedListeners of this.listeners.values()) {
      if (scopedListeners.size > 0) {
        hasListeners = true;
        break;
      }
    }
    if (!hasListeners) {
      if (this.attachedTarget) this.attachedTarget.removeEventListener("storage", this.storageListener);
      this.attachedTarget = null;
      return;
    }

    let nextTarget: StorageEventTargetLike | null | undefined;
    try {
      nextTarget = this.options.getEventTarget?.();
    } catch {
      nextTarget = null;
    }
    if (nextTarget === this.attachedTarget) return;
    if (this.attachedTarget) this.attachedTarget.removeEventListener("storage", this.storageListener);
    this.attachedTarget = nextTarget ?? null;
    this.attachedTarget?.addEventListener("storage", this.storageListener);
  }
}
