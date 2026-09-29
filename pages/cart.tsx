import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LockKeyhole, RotateCcw, ShoppingBasket, Wine } from "lucide-react";
import { Button } from "../components/Button";
import { getCartContext } from "../endpoints/cellar/cart-context_GET.schema";
import { cartBottleCount, removeCartLine, reviewCart, setCartQuantity } from "../helpers/cartPolicy";
import { resetPrivateCart, useCart } from "../helpers/cartStore";
import type { CartContext, CartDraft } from "../helpers/cartPolicy";
import { getCheckout } from "../endpoints/cellar/checkout_GET.schema";
import { postCheckout } from "../endpoints/cellar/checkout_POST.schema";
import { postCheckoutPreview } from "../endpoints/cellar/checkout-preview_POST.schema";
import { normalizeCheckoutDraft } from "../helpers/checkoutPolicy";
import type { CheckoutDraft, CheckoutReceipt } from "../helpers/checkoutPolicy";
import { useCheckoutRecovery } from "../helpers/checkoutRecovery";
import { useAuth } from "../helpers/useAuth";
import CellarMenu from "../components/CellarMenu";
import styles from "./cart.module.css";

type CartWine = CartContext["wines"][number];

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const DefinitiveCheckoutErrors = new Set([
  "PREVIEW_CHANGED",
  "STOCK_UNAVAILABLE",
  "WINE_UNAVAILABLE",
  "RECIPIENT_UNAVAILABLE",
  "HOST_RECIPIENT_UNAVAILABLE",
  "INVALID_CHECKOUT",
  "INVALID_INPUT",
  "INVALID_PREVIEW",
]);

function matchesDraft(left: unknown, right: CheckoutDraft): boolean {
  try { return JSON.stringify(normalizeCheckoutDraft(left)) === JSON.stringify(right); }
  catch { return false; }
}

function CheckoutReceiptView({ receipt }: { receipt: CheckoutReceipt }) {
  return (
    <div className={styles.receiptBody}>
      <h2 id="receipt-title">{receipt.status === "reversed" ? "Checkout reversed." : "Checkout completed."}</h2>
      <p>{receipt.guestName} · {receipt.bottleCount} {receipt.bottleCount === 1 ? "bottle" : "bottles"} · {new Date(receipt.createdAt).toLocaleString()}</p>
      <ul className={styles.pickupItems}>{receipt.items.map((item, index) => <li key={`${item.wineId}-${item.locationId}-${index}`}><span><strong>{item.producer} · {item.wineName}{item.vintage ? ` (${item.vintage})` : ""}</strong><small>{item.fridge} · {item.shelf} · {item.bottleSizeMl} mL</small></span><b>{item.quantity}</b></li>)}</ul>
      <div className={styles.previewRecipients}><strong>Pickup updates for</strong><span>{receipt.recipients.map((recipient) => recipient.displayName).join(", ")}</span></div>
      {receipt.status === "completed" && <p>When the host has connected Telegram, the bot sends the host a pickup message. Delivery can fail; checkout and stock remain complete. The host can forward pickup details to selected guests.</p>}
    </div>
  );
}

function wineTitle(wine: CartWine): string {
  return `${wine.producer} · ${wine.wineName}${wine.vintage ? ` (${wine.vintage})` : ""}`;
}

function privateStateMessage(error: unknown): string {
  if (errorStatus(error) === 401 || errorStatus(error) === 403) return "Private access is no longer available. Sign in or open a current guest invitation.";
  return "Cart details could not be refreshed. Your saved cart stays on this device; retry when connection returns.";
}

export default function CartPage() {
  const queryClient = useQueryClient();
  const { authState } = useAuth();
  const signedInName = authState.type === "authenticated" && typeof authState.user.displayName === "string"
    ? authState.user.displayName.trim().slice(0, 80)
    : "";
  const checkoutGuestName = signedInName || "Guest";
  const query = useQuery({
    queryKey: ["cart-context"],
    queryFn: ({ signal }) => getCartContext({ signal }),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const [privateDenied, setPrivateDenied] = useState(false);
  const deniedAt = useRef(0);
  const context = !privateDenied && !query.isFetching && !query.isError ? query.data ?? null : null;
  // Keep the verified draft subscribed during refresh; context still gates all private UI.
  const cart = useCart(query.data?.scope ?? null);
  const recovery = useCheckoutRecovery(query.data?.scope ?? null);
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [receiptNotice, setReceiptNotice] = useState<{ scope: string; value: CheckoutReceipt } | null>(null);

  const receiptQuery = useQuery({
    queryKey: ["checkout-receipt", query.data?.scope ?? "", recovery.lastReceiptId ?? ""],
    queryFn: () => getCheckout(recovery.lastReceiptId!),
    enabled: Boolean(context && recovery.persistence === "saved" && recovery.lastReceiptId),
    retry: false,
    staleTime: 0,
  });

  const draftKey = useMemo(() => JSON.stringify(cart.draft), [cart.draft]);
  const latestDraftKey = useRef(draftKey);
  latestDraftKey.current = draftKey;
  const latestDraft = useRef(cart.draft);
  latestDraft.current = cart.draft;
  const cachedScope = query.data?.scope ?? null;
  const latestCachedScope = useRef(cachedScope);
  latestCachedScope.current = privateDenied ? null : cachedScope;
  const review = context && cart.persistence !== "loading" ? reviewCart(checkoutDraftForCart(cart.draft), context) : null;
  const loading = query.isPending || query.isFetching || Boolean(context && cart.persistence === "loading");
  const recoveryLoading = Boolean(context && recovery.persistence === "loading");
  const visibleReceiptNotice = context && receiptNotice?.scope === context.scope ? receiptNotice.value : null;
  const protectedOperation = Boolean(recovery.pending || recovery.lastReceiptId || recovery.problem === "invalid" || visibleReceiptNotice);
  const locked = submitting || recoveryLoading || protectedOperation;
  const receipt = recovery.lastReceiptId
    ? (!receiptQuery.isFetching && !receiptQuery.isError && receiptQuery.data?.id === recovery.lastReceiptId ? receiptQuery.data : null)
    : visibleReceiptNotice;

  function denyPrivateAccess() {
    deniedAt.current = query.dataUpdatedAt;
    latestCachedScope.current = null;
    setPrivateDenied(true);
    setReceiptNotice(null);
    resetPrivateCart();
    queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
    void queryClient.cancelQueries({ queryKey: ["cart-context"], exact: true }).then(() => {
      queryClient.setQueryData(["cart-context"], null);
    });
  }

  function invalidateCheckoutQueries() {
    for (const queryKey of [["cart-context"], ["cellar-summary"], ["host-inventory"], ["host-checkouts"], ["host-telegram"], ["wine-catalog"], ["inventory-options"]]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }

  const accessDenied = (!query.isFetching && !query.isError && query.data === null) ||
    (query.isError && (errorStatus(query.error) === 401 || errorStatus(query.error) === 403));
  useEffect(() => {
    if (accessDenied) denyPrivateAccess();
  }, [accessDenied]);

  useEffect(() => {
    if (privateDenied && !query.isFetching && !query.isError && query.data && query.dataUpdatedAt > deniedAt.current) {
      setPrivateDenied(false);
    }
  }, [privateDenied, query.data, query.dataUpdatedAt, query.isError, query.isFetching]);

  useEffect(() => {
    if (errorStatus(receiptQuery.error) === 401 || errorStatus(receiptQuery.error) === 403) denyPrivateAccess();
  }, [receiptQuery.error]);

  function updateDraft(next: typeof cart.draft) {
    cart.save(next);
    setActionError("");
  }

  function removeLine(wineId: string) {
    updateDraft(removeCartLine(cart.draft, wineId));
  }

  function changeQuantity(wineId: string, quantity: number) {
    try {
      updateDraft(setCartQuantity(cart.draft, wineId, quantity, context?.wines ?? []));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Quantity could not be changed.");
    }
  }

  function checkoutDraftForCart(draft: CartDraft): CartDraft {
    return {
      ...draft,
      guestName: checkoutGuestName,
      additionalRecipientIds: [],
    };
  }

  async function executeCheckout(
    intent: { operationId: string; draft: CheckoutDraft; previewHash: string },
    scope: string,
  ) {
    setActionError("");
    try {
      const result = await postCheckout({ operationId: intent.operationId, draft: intent.draft, previewHash: intent.previewHash });
      invalidateCheckoutQueries();
      // Scope check prevents a late response from repopulating private state after logout/invite switch.
      if (latestCachedScope.current !== scope) return;
      setReceiptNotice({ scope, value: result });
      queryClient.setQueryData(["checkout-receipt", scope, result.id], result);
      try {
        await recovery.recordConfirmedCheckout(intent.operationId, result.id);
      } catch {
        if (latestCachedScope.current === scope) {
          setActionError("Checkout completed. Receipt recovery could not be saved on this device. Keep this page open and retry recovery before starting another checkout.");
        }
        return;
      }
      if (latestCachedScope.current !== scope) return;
      const currentCartMatches = matchesDraft(latestDraft.current, intent.draft) || matchesDraft({
        ...latestDraft.current,
        guestName: checkoutGuestName,
        additionalRecipientIds: [],
      }, intent.draft);
      if (currentCartMatches) {
        cart.clear();
        setActionError("");
      } else {
        setActionError("Checkout completed. A newer cart was kept unchanged.");
      }
    } catch (error) {
      const status = errorStatus(error);
      const code = errorCode(error);
      if (latestCachedScope.current !== scope) return;
      if (status === 401 || status === 403) {
        denyPrivateAccess();
        setActionError("Private access is no longer available. Sign in or open a current guest invitation.");
        return;
      }
      if (code && DefinitiveCheckoutErrors.has(code)) {
        try {
          await recovery.clearDefinitiveCheckoutFailure(intent.operationId);
          if (latestCachedScope.current !== scope) return;
          setActionError(`${errorMessage(error, "Checkout could not be completed.")} Refresh availability and try again.`);
        } catch (clearError) {
          if (latestCachedScope.current === scope) {
            setActionError(`${errorMessage(error, "Checkout could not be completed.")} The saved retry could not be cleared: ${errorMessage(clearError, "storage unavailable")}`);
          }
        }
      } else {
        setActionError(`${errorMessage(error, "Checkout result is uncertain.")} Retry this exact checkout to safely recover its result.`);
      }
    }
  }

  async function confirmCheckout() {
    if (!context || submittingRef.current || recoveryLoading) return;
    const scope = context.scope;
    if (!recovery.pending && (locked || cart.persistence === "loading" || recovery.persistence !== "saved")) return;
    if (recovery.pending && recovery.persistence !== "saved") return;

    submittingRef.current = true;
    setSubmitting(true);
    setActionError("");
    if (recovery.pending) {
      try {
        await executeCheckout(recovery.pending, scope);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
      return;
    }

    const snapshot = cart.draft;
    const capturedDraftKey = JSON.stringify(cart.draft);
    try {
      const refreshed = await query.refetch();
      if (refreshed.isError) {
        setActionError(privateStateMessage(refreshed.error));
        if (errorStatus(refreshed.error) === 401 || errorStatus(refreshed.error) === 403) denyPrivateAccess();
        return;
      }
      if (!refreshed.data) {
        denyPrivateAccess();
        setActionError("Private access is no longer available. Your cart was cleared.");
        return;
      }
      if (
        refreshed.data.scope !== scope ||
        latestCachedScope.current !== scope ||
        latestDraftKey.current !== capturedDraftKey
      ) {
        setActionError("Cart or private access changed during checkout. Refresh and try again.");
        return;
      }
      const effectiveDraft = checkoutDraftForCart(snapshot);
      const freshReview = reviewCart(effectiveDraft, refreshed.data);
      if (!freshReview.ready) {
        setActionError(`Resolve cart issues before checkout: ${freshReview.issues.join(" ")}`);
        return;
      }

      const capturedDataUpdatedAt = refreshed.dataUpdatedAt;
      const checkoutDraft = normalizeCheckoutDraft(effectiveDraft);
      const preview = await postCheckoutPreview({ draft: checkoutDraft });
      // React may render after a fast response; inspect the query cache synchronously.
      const currentContextState = queryClient.getQueryState<CartContext | null>(["cart-context"]);
      if (
        latestCachedScope.current !== scope ||
        latestDraftKey.current !== capturedDraftKey ||
        currentContextState?.data?.scope !== scope ||
        currentContextState.dataUpdatedAt !== capturedDataUpdatedAt
      ) {
        setActionError("Cart or private access changed during checkout. Refresh and try again.");
        return;
      }

      const intent = await recovery.beginOrReuseCheckout(
        checkoutDraft,
        preview.previewHash,
      );
      if (latestCachedScope.current !== scope || queryClient.getQueryData<CartContext | null>(["cart-context"])?.scope !== scope) return;
      if (latestDraftKey.current !== capturedDraftKey) {
        setActionError("Cart changed while saving checkout recovery. Retry saved checkout to resolve result.");
        return;
      }
      await executeCheckout(intent, scope);
    } catch (error) {
      if (latestCachedScope.current === scope) {
        if (errorStatus(error) === 401 || errorStatus(error) === 403) {
          denyPrivateAccess();
          setActionError("Private access is no longer available. Sign in or open a current guest invitation.");
        } else {
          setActionError(errorMessage(error, "Checkout could not be prepared. No checkout was submitted."));
        }
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function startNewRequest() {
    if (!context) return;
    const scope = context.scope;
    try {
      await recovery.startNew();
      if (latestCachedScope.current !== scope) return;
      setReceiptNotice(null);
      setActionError("");
    } catch (error) {
      if (latestCachedScope.current === scope) {
        setActionError(errorMessage(error, "Saved receipt could not be cleared. Retry when storage is available."));
      }
    }
  }

  const currentReview = review;

  return (
    <div className={styles.frame}>
      <CellarMenu>
          <Link to="/">Overview</Link>
          <Link to="/wines">Wine inventory</Link>
          <Link to="/cart" aria-current="page">Cart {context && cart.persistence !== "loading" ? <span className={styles.navCount}>{cartBottleCount(cart.draft)}</span> : null}</Link>
          {context?.role === "host" && <Link to="/host-access">Host access</Link>}
          {context?.role === "host" && <Link to="/host-dashboard">Host dashboard</Link>}
        
      </CellarMenu>

      <main className={styles.main}>
        <header className={styles.topbar}><span>YOUR CELLAR　/　CART</span><span className={styles.privacy}>PRIVATE ACCESS</span></header>
        <div className={styles.content}>
          <Link to="/wines" className={styles.backLink}><ArrowLeft size={14} aria-hidden="true" /> Wine inventory</Link>
          <p className={styles.eyebrow}>YOUR DINNER SELECTION</p>
          <h1>Cart for the table.</h1>
          <p className={styles.intro}>Current stock and pickup locations checked at confirmation. Bottles deduct only after validation.</p>

          {loading ? (
            <section className={styles.state} role="status" aria-live="polite"><ShoppingBasket size={24} aria-hidden="true" /><h2>Checking your cart</h2><p>Refreshing private access, wine availability, and active recipients…</p><div className={styles.loadingBar} /></section>
          ) : query.isError ? (
            <section className={styles.state} role="alert"><ShoppingBasket size={24} aria-hidden="true" /><h2>Cart details unavailable</h2><p>{privateStateMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></section>
          ) : !context ? (
            <section className={`${styles.state} ${styles.gate}`}><span className={styles.lockBadge}><LockKeyhole size={20} aria-hidden="true" /></span><p className={styles.eyebrow}>PRIVATE COLLECTION</p><h2>This cellar is kept private.</h2><p>Sign in as the host, or open the current private guest invitation shared by your host.</p><Button asChild className={styles.signIn}><Link to="/login">Host sign in <span aria-hidden="true">→</span></Link></Button></section>
          ) : (
            <>
              <div className={styles.actions}>
                <span className={styles.bottleTotal}>{cartBottleCount(cart.draft)} {cartBottleCount(cart.draft) === 1 ? "bottle" : "bottles"} requested</span>
                <Button variant="outline" onClick={() => void query.refetch()} disabled={submitting || locked}><RotateCcw size={15} aria-hidden="true" /> Refresh availability</Button>
                <Button variant="ghost" onClick={() => { cart.clear(); setActionError(""); }} disabled={cart.draft.lines.length === 0 || locked}><span aria-hidden="true">×</span> Clear cart</Button>
              </div>

              {actionError && <p className={styles.error} role="alert">{actionError}</p>}

              {cart.persistence === "memory" && <p className={styles.memoryNote} role="status">Browser storage is unavailable. Cart stays in memory; checkout needs saved recovery storage.</p>}
              {recovery.persistence === "memory" && <p className={styles.memoryNote} role="status">Checkout recovery storage is unavailable. You can edit the cart, but checkout stays blocked until recovery can be saved.</p>}
              {recovery.problem === "invalid" && <p className={styles.error} role="alert">Saved checkout recovery is invalid. Do not submit another checkout; contact the cellar host.</p>}

              {recovery.pending && (
                <section className={styles.recoveryPanel} aria-labelledby="pending-checkout-title">
                  <p className={styles.miniEyebrow}>CHECKOUT RECOVERY</p>
                  <h2 id="pending-checkout-title">Checkout result needs confirmation.</h2>
                  <p>Confirm retries this exact saved checkout and safely checks its result without deducting bottles twice.</p>
                  <p><strong>{recovery.pending.draft.guestName}</strong> · {recovery.pending.draft.lines.reduce((sum, line) => sum + line.quantity, 0)} bottles</p>
                  <Button onClick={() => void confirmCheckout()} disabled={submitting || recovery.persistence !== "saved" || recovery.problem === "invalid"}>{submitting ? "Checking result…" : "Confirm checkout"}</Button>
                </section>
              )}

              {(recovery.lastReceiptId || visibleReceiptNotice) && (
                <section className={styles.recoveryPanel} aria-labelledby="receipt-title">
                  <p className={styles.miniEyebrow}>SAVED RECEIPT</p>
                  {recovery.lastReceiptId && receiptQuery.isPending && !receipt && <p role="status">Loading saved checkout receipt…</p>}
                  {recovery.lastReceiptId && receiptQuery.isError && !receipt && <p role="alert">Saved receipt could not be loaded. Retry when connection returns.</p>}
                  {receipt && <CheckoutReceiptView receipt={receipt} />}
                  {recovery.lastReceiptId && receiptQuery.isError && <Button variant="outline" onClick={() => void receiptQuery.refetch()}>Retry receipt</Button>}
                  {recovery.lastReceiptId && <Button variant="outline" onClick={() => void startNewRequest()} disabled={submitting || recovery.persistence !== "saved"}>Start a new request</Button>}
                </section>
              )}
              {recoveryLoading && <p className={styles.memoryNote} role="status">Checking saved checkout recovery…</p>}

              {cart.draft.lines.length === 0 ? (
                <section className={styles.empty}><ShoppingBasket size={24} aria-hidden="true" /><h2>Your cart is empty.</h2><p>Browse the wine inventory and add bottles you may want for dinner.</p><Button asChild><Link to="/wines">Browse wines</Link></Button></section>
              ) : (
                <div className={styles.cartForm}>
                  <section className={styles.lineSection} aria-labelledby="cart-lines-title">
                    <div className={styles.sectionHeading}><div><p className={styles.miniEyebrow}>CURRENT STOCK</p><h2 id="cart-lines-title">Selected bottles</h2></div><span>AVAILABILITY CAN CHANGE</span></div>
                    {currentReview?.issues.length ? <ul className={styles.issueList} aria-label="Cart issues">{currentReview.issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul> : null}
                    <div className={styles.lines}>
                      {currentReview?.lines.map((line) => {
                        const wine = line.wine;
                        return (
                          <article className={styles.line} key={line.wineId}>
                            <div className={styles.lineInfo}>
                              <strong>{wine ? wineTitle(wine) : "Wine no longer available"}</strong>
                              <span>{wine ? `${wine.bottleSizeMl} mL · ${line.available} available now` : "This item remains in your cart until you remove it."}</span>
                              {wine?.locations.length ? <ul className={styles.stockLocations}>{wine.locations.map((location) => <li key={location.locationId}><span>{location.fridge} · {location.shelf}</span><strong>{location.quantity} {location.quantity === 1 ? "bottle" : "bottles"}</strong></li>)}</ul> : wine ? <span className={styles.issueText}>No current stock at any location.</span> : null}
                              {line.issue && <span className={styles.issueText}>{line.issue}</span>}
                            </div>
                            <div className={styles.lineControls}>
                              <label className={styles.quantityControl}><span>Quantity</span><span className={styles.stepper}><button type="button" aria-label={`Reduce ${wine ? wineTitle(wine) : "wine"} quantity`} disabled={!wine || locked || line.quantity <= 1} onClick={() => changeQuantity(line.wineId, line.quantity - 1)}>−</button><output aria-live="polite">{line.quantity}</output><button type="button" aria-label={`Increase ${wine ? wineTitle(wine) : "wine"} quantity`} disabled={!wine || locked || line.quantity >= Math.min(2147483647, line.available)} onClick={() => changeQuantity(line.wineId, line.quantity + 1)}>+</button></span></label>
                              <button type="button" className={styles.removeButton} disabled={locked} onClick={() => removeLine(line.wineId)}>Remove</button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>

                  {!recovery.pending && !recovery.lastReceiptId && !visibleReceiptNotice && recovery.problem !== "invalid" && (
                    <div className={styles.checkoutAction}>
                      <Button onClick={() => void confirmCheckout()} disabled={submitting || cart.persistence === "loading" || recovery.persistence !== "saved" || locked || Boolean(currentReview && !currentReview.ready)}>{submitting ? "Checking stock…" : "Confirm checkout"}</Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <footer className={styles.footer}><span>DINNER CELLAR</span><span>Shared for the table, kept with care.</span></footer>
        </div>
      </main>
    </div>
  );
}
