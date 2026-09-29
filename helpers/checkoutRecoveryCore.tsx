export type RecoveryPersistence = "saved" | "memory" | "loading";
export type RecoveryProblem = "storage" | "invalid" | null;

export type CheckoutIntent<TDraft> = {
  operationId: string;
  draft: TDraft;
  previewHash: string;
};

export type RecoveryRecord<TDraft> = {
  pending: CheckoutIntent<TDraft> | null;
  lastReceiptId: string | null;
  reversals: Record<string, string>;
};

export type RecoverySnapshot<TDraft> = RecoveryRecord<TDraft> & {
  persistence: RecoveryPersistence;
  problem: RecoveryProblem;
};

export type RecoveryStorage = {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
};

export type RecoveryLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T> | T,
  ): Promise<T>;
};

export type RecoveryStorageEvent = { key: string | null; storageArea?: unknown };
export type RecoveryEventTarget = {
  addEventListener(type: "storage", listener: (event: RecoveryStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: RecoveryStorageEvent) => void): void;
};

type CheckoutRecoveryOptions<TDraft> = {
  getStorage: () => RecoveryStorage | null | undefined;
  getLocks: () => RecoveryLockManager | null | undefined;
  getEventTarget?: () => RecoveryEventTarget | null | undefined;
  normalizeDraft: (value: unknown) => TDraft;
  createId: () => string;
  storagePrefix: string;
  maxBytes?: number;
};

export class CheckoutRecoveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CheckoutRecoveryError";
  }
}

type Slot<TDraft> = {
  snapshot: RecoverySnapshot<TDraft>;
  hydrated: boolean;
};

const MaxScopeLength = 256;
const DefaultMaxBytes = 24 * 1024;
const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HashPattern = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}

function emptyRecord<TDraft>(): RecoveryRecord<TDraft> {
  return { pending: null, lastReceiptId: null, reversals: {} };
}

/** Storage + Web Locks coordinator for immutable checkout and reversal retries. */
export class CheckoutRecoveryCore<TDraft> {
  private readonly slots = new Map<string, Slot<TDraft>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private resetRevision = 0;
  private attachedTarget: RecoveryEventTarget | null = null;
  private readonly loadingSnapshot: RecoverySnapshot<TDraft> = {
    ...emptyRecord<TDraft>(),
    persistence: "loading",
    problem: null,
  };
  private readonly storageListener = (event: RecoveryStorageEvent) => {
    try {
      const storage = this.options.getStorage();
      if (event.storageArea && storage && event.storageArea !== storage) return;
    } catch {
      // The refresh below reports an inaccessible adapter as memory-only.
    }
    this.handleStorageChange(event.key);
  };
  private readonly options: CheckoutRecoveryOptions<TDraft>;

  constructor(options: CheckoutRecoveryOptions<TDraft>) {
    this.options = options;
  }

  snapshot(scope: string | null): RecoverySnapshot<TDraft> {
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
    this.syncEventListener();
    return () => {
      const current = this.listeners.get(scope);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(scope);
      this.syncEventListener();
    };
  }

  hydrate(scope: string | null): void {
    if (!this.isValidScope(scope)) return;
    const slot = this.getSlot(scope);
    if (slot.hydrated && slot.snapshot.persistence === "memory") return;
    this.refresh(scope);
  }

  async beginOrReuseCheckout(scope: string, draft: unknown, previewHash: string): Promise<CheckoutIntent<TDraft>> {
    this.requireValidScope(scope);
    if (!HashPattern.test(previewHash)) throw new CheckoutRecoveryError("INVALID_PREVIEW", "Checkout preview is invalid. Refresh it before continuing.");
    let safeDraft: TDraft;
    try {
      safeDraft = this.options.normalizeDraft(draft);
    } catch {
      throw new CheckoutRecoveryError("INVALID_DRAFT", "Cart details are invalid. Review the cart before continuing.");
    }

    const revision = this.resetRevision;
    return this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      if (record.pending) {
        if (record.pending.previewHash === previewHash && this.sameDraft(record.pending.draft, safeDraft)) {
          this.update(scope, record, "saved", null, true);
          return record.pending;
        }
        throw new CheckoutRecoveryError("PENDING_CHECKOUT", "A different checkout is still pending. Retry that exact checkout first.");
      }
      if (record.lastReceiptId) {
        throw new CheckoutRecoveryError("RECEIPT_EXISTS", "Start a new request after reviewing the completed receipt.");
      }
      const operationId = this.createValidId();
      const intent = { operationId, draft: safeDraft, previewHash };
      await this.writeRecord(scope, { ...record, pending: intent }, storage);
      this.assertResetRevision(revision);
      return intent;
    });
  }

  async recordConfirmedCheckout(scope: string, operationId: string, receiptId: string): Promise<void> {
    this.requireValidScope(scope);
    if (!UuidPattern.test(operationId) || !UuidPattern.test(receiptId)) {
      throw new CheckoutRecoveryError("INVALID_RECEIPT", "Checkout receipt could not be saved safely.");
    }
    const revision = this.resetRevision;
    await this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      if (!record.pending && record.lastReceiptId === receiptId) {
        this.update(scope, record, "saved", null, true);
        return;
      }
      if (!record.pending || record.pending.operationId !== operationId) {
        throw new CheckoutRecoveryError("PENDING_CHANGED", "Pending checkout changed in another tab. Refresh recovery state.");
      }
      await this.writeRecord(scope, { ...record, pending: null, lastReceiptId: receiptId }, storage);
      this.assertResetRevision(revision);
    });
  }

  async clearDefinitiveCheckoutFailure(scope: string, operationId: string): Promise<void> {
    this.requireValidScope(scope);
    const revision = this.resetRevision;
    await this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      if (!record.pending || record.pending.operationId !== operationId) return;
      await this.writeRecord(scope, { ...record, pending: null }, storage);
      this.assertResetRevision(revision);
    });
  }

  async startNew(scope: string): Promise<void> {
    this.requireValidScope(scope);
    const revision = this.resetRevision;
    await this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      if (record.pending) throw new CheckoutRecoveryError("PENDING_CHECKOUT", "Resolve the pending checkout before starting a new request.");
      if (record.lastReceiptId) {
        await this.writeRecord(scope, { ...record, lastReceiptId: null }, storage);
        this.assertResetRevision(revision);
      }
      else this.update(scope, record, "saved", null, true);
    });
  }

  async beginOrReuseReversal(scope: string, checkoutId: string): Promise<string> {
    this.requireValidScope(scope);
    if (!UuidPattern.test(checkoutId)) throw new CheckoutRecoveryError("INVALID_CHECKOUT", "Checkout ID is invalid.");
    const revision = this.resetRevision;
    return this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      const existing = record.reversals[checkoutId];
      if (existing) {
        this.update(scope, record, "saved", null, true);
        return existing;
      }
      if (Object.keys(record.reversals).length >= 100) throw new CheckoutRecoveryError("REVERSAL_LIMIT", "Resolve saved reversal retries before starting another.");
      const operationId = this.createValidId();
      await this.writeRecord(scope, { ...record, reversals: { ...record.reversals, [checkoutId]: operationId } }, storage);
      this.assertResetRevision(revision);
      return operationId;
    });
  }

  async finishReversal(scope: string, checkoutId: string, operationId: string): Promise<void> {
    this.requireValidScope(scope);
    const revision = this.resetRevision;
    await this.withLock(scope, async () => {
      this.assertResetRevision(revision);
      const storage = this.requireStorage();
      const record = this.readRecord(scope, storage);
      const savedId = record.reversals[checkoutId];
      if (!savedId) return;
      if (savedId !== operationId) throw new CheckoutRecoveryError("REVERSAL_CHANGED", "Reversal retry changed in another tab.");
      const reversals = { ...record.reversals };
      delete reversals[checkoutId];
      await this.writeRecord(scope, { ...record, reversals }, storage);
      this.assertResetRevision(revision);
    });
  }

  resetAll(): void {
    this.resetRevision += 1;
    let persistence: RecoveryPersistence = "memory";
    try {
      const storage = this.options.getStorage();
      if (storage) {
        persistence = "saved";
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(this.options.storagePrefix)) keys.push(key);
        }
        for (const key of keys) {
          try { storage.removeItem(key); }
          catch { persistence = "memory"; }
        }
      }
    } catch {
      persistence = "memory";
    }
    for (const [scope] of this.slots) this.update(scope, emptyRecord<TDraft>(), persistence, null, true);
  }

  handleStorageChange(key: string | null): void {
    if (key === null) {
      for (const [scope, slot] of this.slots) if (slot.hydrated) this.refresh(scope);
      return;
    }
    if (!key.startsWith(this.options.storagePrefix)) return;
    let scope: string;
    try {
      scope = decodeURIComponent(key.slice(this.options.storagePrefix.length));
    } catch {
      return;
    }
    if (this.isValidScope(scope) && this.slots.get(scope)?.hydrated) this.refresh(scope);
  }

  private get maxBytes(): number { return this.options.maxBytes ?? DefaultMaxBytes; }
  private isValidScope(scope: string | null): scope is string {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > MaxScopeLength) return false;
    try { encodeURIComponent(scope); return true; } catch { return false; }
  }
  private requireValidScope(scope: string): void {
    if (!this.isValidScope(scope)) throw new CheckoutRecoveryError("INVALID_SCOPE", "Private checkout scope is unavailable.");
  }
  private assertResetRevision(revision: number): void {
    if (revision !== this.resetRevision) {
      throw new CheckoutRecoveryError("AUTH_RESET", "Private checkout recovery was cleared. Use the current access context to continue.");
    }
  }
  private storageKey(scope: string): string { return `${this.options.storagePrefix}${encodeURIComponent(scope)}`; }
  private getSlot(scope: string): Slot<TDraft> {
    let slot = this.slots.get(scope);
    if (!slot) {
      slot = { snapshot: { ...emptyRecord<TDraft>(), persistence: "loading", problem: null }, hydrated: false };
      this.slots.set(scope, slot);
    }
    return slot;
  }
  private requireStorage(): RecoveryStorage {
    let storage: RecoveryStorage | null | undefined;
    try { storage = this.options.getStorage(); } catch { storage = null; }
    if (!storage) throw new CheckoutRecoveryError("STORAGE_UNAVAILABLE", "Browser storage is unavailable. Preserve the pending operation and retry recovery.");
    return storage;
  }
  private createValidId(): string {
    let id: string;
    try { id = this.options.createId(); } catch { id = ""; }
    if (!UuidPattern.test(id)) throw new CheckoutRecoveryError("UUID_UNAVAILABLE", "A secure checkout retry ID could not be created.");
    return id.toLowerCase();
  }
  private async withLock<T>(scope: string, run: () => Promise<T>): Promise<T> {
    let locks: RecoveryLockManager | null | undefined;
    try { locks = this.options.getLocks(); } catch { locks = null; }
    if (!locks || typeof locks.request !== "function") {
      throw new CheckoutRecoveryError("WEB_LOCKS_UNAVAILABLE", "This browser cannot safely coordinate checkout across tabs. Use a browser with Web Locks enabled.");
    }
    try {
      return await locks.request(`dinner-cellar:checkout-recovery:${encodeURIComponent(scope)}`, { mode: "exclusive" }, run);
    } catch (error) {
      if (error instanceof CheckoutRecoveryError) throw error;
      throw new CheckoutRecoveryError("LOCK_FAILED", "Checkout recovery lock failed. Preserve the current operation and retry recovery.");
    }
  }
  private readRecord(scope: string, storage: RecoveryStorage): RecoveryRecord<TDraft> {
    let raw: string | null;
    try { raw = storage.getItem(this.storageKey(scope)); }
    catch { throw new CheckoutRecoveryError("STORAGE_UNAVAILABLE", "Saved checkout recovery could not be read. Preserve the pending operation and retry recovery."); }
    if (raw === null) return emptyRecord<TDraft>();
    if (utf8ByteLength(raw) > this.maxBytes) throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is oversized. Do not start another checkout; contact the cellar host.");

    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is invalid. Do not start another checkout; contact the cellar host."); }
    if (!isRecord(value) || !hasExactKeys(value, ["version", "scope", "pending", "lastReceiptId", "reversals"]) || value.version !== 1 || value.scope !== scope) {
      throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is invalid. Do not start another checkout; contact the cellar host.");
    }

    let pending: CheckoutIntent<TDraft> | null = null;
    if (value.pending !== null) {
      const candidate = value.pending;
      if (!isRecord(candidate) || !hasExactKeys(candidate, ["operationId", "draft", "previewHash"]) || typeof candidate.operationId !== "string" || !UuidPattern.test(candidate.operationId) || typeof candidate.previewHash !== "string" || !HashPattern.test(candidate.previewHash)) {
        throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is invalid. Do not start another checkout; contact the cellar host.");
      }
      let normalized: TDraft;
      try { normalized = this.options.normalizeDraft(candidate.draft); }
      catch { throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is invalid. Do not start another checkout; contact the cellar host."); }
      if (!this.sameDraft(normalized, candidate.draft)) throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout recovery data is not canonical. Do not start another checkout.");
      pending = { operationId: candidate.operationId.toLowerCase(), draft: normalized, previewHash: candidate.previewHash.toLowerCase() };
    }

    const lastReceiptId = value.lastReceiptId;
    if (lastReceiptId !== null && (typeof lastReceiptId !== "string" || !UuidPattern.test(lastReceiptId))) {
      throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved checkout receipt ID is invalid. Do not start another checkout.");
    }
    if (!isRecord(value.reversals) || Object.keys(value.reversals).length > 100) {
      throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved reversal recovery data is invalid.");
    }
    const reversals: Record<string, string> = {};
    for (const [checkoutId, operationId] of Object.entries(value.reversals)) {
      if (!UuidPattern.test(checkoutId) || typeof operationId !== "string" || !UuidPattern.test(operationId)) {
        throw new CheckoutRecoveryError("INVALID_RECOVERY", "Saved reversal recovery data is invalid.");
      }
      reversals[checkoutId.toLowerCase()] = operationId.toLowerCase();
    }
    return { pending, lastReceiptId: lastReceiptId?.toLowerCase() ?? null, reversals };
  }
  private sameDraft(left: unknown, right: unknown): boolean {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }
  private async writeRecord(scope: string, record: RecoveryRecord<TDraft>, storage: RecoveryStorage): Promise<void> {
    const envelope = { version: 1, scope, ...record };
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
      if (utf8ByteLength(serialized) > this.maxBytes) throw new Error("oversized");
      storage.setItem(this.storageKey(scope), serialized);
    } catch {
      const prior = this.getSlot(scope).snapshot;
      this.update(scope, {
        pending: prior.pending,
        lastReceiptId: prior.lastReceiptId,
        reversals: prior.reversals,
      }, "memory", "storage", true);
      throw new CheckoutRecoveryError("STORAGE_WRITE_FAILED", "Checkout recovery could not be saved. Preserve the current operation and retry recovery.");
    }
    this.update(scope, record, "saved", null, true);
  }
  private refresh(scope: string): void {
    const slot = this.getSlot(scope);
    try {
      const storage = this.options.getStorage();
      if (!storage) {
        this.update(scope, slot.snapshot, "memory", "storage", true);
        return;
      }
      const record = this.readRecord(scope, storage);
      this.update(scope, record, "saved", null, true);
    } catch (error) {
      if (error instanceof CheckoutRecoveryError && error.code === "INVALID_RECOVERY") {
        this.update(scope, slot.snapshot, "saved", "invalid", true);
      } else {
        this.update(scope, slot.snapshot, "memory", "storage", true);
      }
    }
  }
  private update(scope: string, record: RecoveryRecord<TDraft>, persistence: RecoveryPersistence, problem: RecoveryProblem, hydrated: boolean): void {
    const slot = this.getSlot(scope);
    slot.snapshot = { ...record, persistence, problem };
    slot.hydrated = hydrated;
    for (const listener of this.listeners.get(scope) ?? []) listener();
  }
  private syncEventListener(): void {
    const hasListeners = [...this.listeners.values()].some((set) => set.size > 0);
    if (!hasListeners) {
      this.attachedTarget?.removeEventListener("storage", this.storageListener);
      this.attachedTarget = null;
      return;
    }
    let target: RecoveryEventTarget | null | undefined;
    try { target = this.options.getEventTarget?.(); } catch { target = null; }
    if (target === this.attachedTarget) return;
    this.attachedTarget?.removeEventListener("storage", this.storageListener);
    this.attachedTarget = target ?? null;
    this.attachedTarget?.addEventListener("storage", this.storageListener);
  }
}
