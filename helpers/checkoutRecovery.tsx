import { useCallback, useEffect, useSyncExternalStore } from "react";
import { normalizeCheckoutDraft } from "./checkoutPolicy";
import type { CheckoutDraft } from "./checkoutPolicy";
import {
  CheckoutRecoveryCore,
  type CheckoutIntent,
  type RecoveryEventTarget,
  type RecoveryLockManager,
  type RecoveryPersistence,
  type RecoverySnapshot,
  type RecoveryStorage,
} from "./checkoutRecoveryCore";

const StoragePrefix = "dinner-cellar:cart:checkout:v1:";

function getBrowserStorage(): RecoveryStorage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function getBrowserLocks(): RecoveryLockManager | null {
  if (typeof navigator === "undefined") return null;
  try {
    const locks = (navigator as unknown as { locks?: RecoveryLockManager }).locks;
    return locks ?? null;
  } catch {
    return null;
  }
}

function getStorageEventTarget(): RecoveryEventTarget | null {
  if (typeof window === "undefined") return null;
  return window as unknown as RecoveryEventTarget;
}

function createOperationId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return "";
  return crypto.randomUUID();
}

const recovery = new CheckoutRecoveryCore<CheckoutDraft>({
  getStorage: getBrowserStorage,
  getLocks: getBrowserLocks,
  getEventTarget: getStorageEventTarget,
  normalizeDraft: normalizeCheckoutDraft,
  createId: createOperationId,
  storagePrefix: StoragePrefix,
  maxBytes: 24 * 1024,
});

const noScopeSnapshot: RecoverySnapshot<CheckoutDraft> = {
  pending: null,
  lastReceiptId: null,
  reversals: {},
  persistence: "loading",
  problem: null,
};

export type CheckoutRecoveryState = RecoverySnapshot<CheckoutDraft> & {
  beginOrReuseCheckout: (draft: CheckoutDraft, previewHash: string) => Promise<CheckoutIntent<CheckoutDraft>>;
  recordConfirmedCheckout: (operationId: string, receiptId: string) => Promise<void>;
  clearDefinitiveCheckoutFailure: (operationId: string) => Promise<void>;
  startNew: () => Promise<void>;
  beginOrReuseReversal: (checkoutId: string) => Promise<string>;
  finishReversal: (checkoutId: string, operationId: string) => Promise<void>;
};

export function useCheckoutRecovery(scope: string | null): CheckoutRecoveryState {
  const subscribe = useCallback(
    (listener: () => void) => recovery.subscribe(scope, listener),
    [scope],
  );
  const getSnapshot = useCallback(
    () => (scope === null ? noScopeSnapshot : recovery.snapshot(scope)),
    [scope],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => noScopeSnapshot);

  useEffect(() => {
    if (scope !== null) recovery.hydrate(scope);
  }, [scope]);

  const beginOrReuseCheckout = useCallback(
    (draft: CheckoutDraft, previewHash: string) => {
      if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
      return recovery.beginOrReuseCheckout(scope, draft, previewHash);
    },
    [scope],
  );
  const recordConfirmedCheckout = useCallback(
    (operationId: string, receiptId: string) => {
      if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
      return recovery.recordConfirmedCheckout(scope, operationId, receiptId);
    },
    [scope],
  );
  const clearDefinitiveCheckoutFailure = useCallback(
    (operationId: string) => {
      if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
      return recovery.clearDefinitiveCheckoutFailure(scope, operationId);
    },
    [scope],
  );
  const startNew = useCallback(() => {
    if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
    return recovery.startNew(scope);
  }, [scope]);
  const beginOrReuseReversal = useCallback(
    (checkoutId: string) => {
      if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
      return recovery.beginOrReuseReversal(scope, checkoutId);
    },
    [scope],
  );
  const finishReversal = useCallback(
    (checkoutId: string, operationId: string) => {
      if (scope === null) return Promise.reject(new Error("Private checkout scope is unavailable."));
      return recovery.finishReversal(scope, checkoutId, operationId);
    },
    [scope],
  );

  return {
    ...snapshot,
    beginOrReuseCheckout,
    recordConfirmedCheckout,
    clearDefinitiveCheckoutFailure,
    startNew,
    beginOrReuseReversal,
    finishReversal,
  };
}

export function resetCheckoutRecovery(): void {
  recovery.resetAll();
}

export type { RecoveryPersistence };
