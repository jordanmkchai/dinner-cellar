import { useCallback, useEffect, useSyncExternalStore } from "react";
import { emptyCart, sanitizeStoredCart } from "./cartPolicy";
import type { CartDraft } from "./cartPolicy";
import { resetCheckoutRecovery } from "./checkoutRecovery";
import {
  CartStoreCore,
  type CartPersistence,
  type CartStorage,
  type StorageEventTargetLike,
} from "./cartStoreCore";

const StoragePrefix = "dinner-cellar:cart:v1:";
const StorageRoot = "dinner-cellar:cart:";

function getBrowserStorage(): CartStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getStorageEventTarget(): StorageEventTargetLike | null {
  if (typeof window === "undefined") return null;
  return window as unknown as StorageEventTargetLike;
}

const store = new CartStoreCore<CartDraft>({
  getStorage: getBrowserStorage,
  getEventTarget: getStorageEventTarget,
  emptyDraft: emptyCart,
  sanitizeDraft: sanitizeStoredCart,
  storagePrefix: StoragePrefix,
  storageRoot: StorageRoot,
  maxBytes: 16 * 1024,
});

const noScopeSnapshot = { draft: emptyCart(), persistence: "loading" as const };

export type CartState = {
  draft: CartDraft;
  save: (draft: CartDraft) => void;
  clear: () => void;
  persistence: CartPersistence;
};

/** Scope must come from a fresh, authorized cart-context response. */
export function useCart(scope: string | null): CartState {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(scope, listener),
    [scope],
  );
  const getSnapshot = useCallback(
    () => (scope === null ? noScopeSnapshot : store.snapshot(scope)),
    [scope],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => noScopeSnapshot);

  useEffect(() => {
    if (scope !== null) store.hydrate(scope);
  }, [scope]);

  const save = useCallback((draft: CartDraft) => store.save(scope, draft), [scope]);
  const clear = useCallback(() => store.clear(scope), [scope]);

  return { ...snapshot, save, clear };
}

/** Synchronously clear all scoped drafts on successful auth/invitation boundaries. */
export function resetPrivateCart(): void {
  resetCheckoutRecovery();
  store.resetAll();
}
