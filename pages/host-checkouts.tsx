import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, LockKeyhole, RefreshCw, RotateCcw, ShieldCheck, Wine } from "lucide-react";
import { getCartContext } from "../endpoints/cellar/cart-context_GET.schema";
import { getHostCheckouts } from "../endpoints/host/checkouts_GET.schema";
import { postReverseCheckout } from "../endpoints/host/checkout-reverse_POST.schema";
import { useAuth } from "../helpers/useAuth";
import { useCheckoutRecovery } from "../helpers/checkoutRecovery";
import { resetPrivateCart } from "../helpers/cartStore";
import type { CheckoutReceipt } from "../helpers/checkoutPolicy";
import CellarMenu from "../components/CellarMenu";
import styles from "./host-checkouts.module.css";
import { PickupShare } from "../components/PickupShare";
import { getTelegramStatus, TelegramDeliveryStatus, TelegramSettings } from "../components/TelegramSettings";

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function wineLabel(item: CheckoutReceipt["items"][number]): string {
  return `${item.producer} · ${item.wineName}${item.vintage ? ` (${item.vintage})` : ""}`;
}

export default function HostCheckoutsPage() {
  const { authState } = useAuth();
  const queryClient = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [rejectedPrincipal, setRejectedPrincipal] = useState<object | null>(null);
  const principal = authState.type === "authenticated" ? authState.user as object : null;
  const principalRejected = principal !== null && rejectedPrincipal === principal;

  const contextQuery = useQuery({
    queryKey: ["cart-context"],
    queryFn: ({ signal }) => getCartContext({ signal }),
    enabled: authState.type === "authenticated" && !principalRejected,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const context = !contextQuery.isFetching && !contextQuery.isError ? contextQuery.data ?? null : null;
  const contextDenied = authState.type === "authenticated" && contextQuery.data === null && !contextQuery.isFetching && !contextQuery.isError;
  const contextAccessDenied = contextDenied || errorStatus(contextQuery.error) === 401 || errorStatus(contextQuery.error) === 403 ||
    (context !== null && context.role !== "host");
  const candidateScope = !contextAccessDenied && !principalRejected && authState.type === "authenticated" && context?.role === "host"
    ? context.scope
    : null;
  const historyQuery = useQuery({
    queryKey: ["host-checkouts"],
    queryFn: ({ signal }) => getHostCheckouts({ signal }),
    enabled: candidateScope !== null,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const telegramQuery = useQuery({
    queryKey: ["host-telegram", candidateScope ?? ""],
    queryFn: getTelegramStatus,
    enabled: candidateScope !== null,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  const historyDenied = errorStatus(historyQuery.error) === 401 || errorStatus(historyQuery.error) === 403;
  const telegramDenied = errorStatus(telegramQuery.error) === 401 || errorStatus(telegramQuery.error) === 403;
  const confirmedDenial = contextAccessDenied || historyDenied || telegramDenied;
  const denied = confirmedDenial || principalRejected;
  const hostScope = denied ? null : candidateScope;
  const latestScopeRef = useRef<string | null>(hostScope);
  latestScopeRef.current = hostScope;
  const recovery = useCheckoutRecovery(hostScope);
  const historyEnabled = hostScope !== null;
  const busy = Boolean(workingId);
  const recoveryReady = recovery.persistence === "saved" && recovery.problem !== "invalid";
  const checkouts = !historyQuery.isFetching && !historyQuery.isError && historyEnabled
    ? historyQuery.data?.checkouts ?? []
    : [];

  useEffect(() => {
    if (!confirmedDenial || !principal) return;
    setRejectedPrincipal(principal);
    resetPrivateCart();
    queryClient.removeQueries({ queryKey: ["host-checkouts"] });
    queryClient.removeQueries({ queryKey: ["host-telegram"] });
    queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
    queryClient.removeQueries({ queryKey: ["cart-context"] });
  }, [confirmedDenial, principal, queryClient]);

  useEffect(() => {
    setConfirmingId(null);
    setWorkingId(null);
    setActionError("");
    setNotice("");
  }, [hostScope]);

  async function reverse(receipt: CheckoutReceipt) {
    const submittedScope = hostScope;
    if (!submittedScope || latestScopeRef.current !== submittedScope || !recoveryReady || busy) return;
    const isCurrent = () => latestScopeRef.current === submittedScope;
    setWorkingId(receipt.id);
    setActionError("");
    setNotice("");
    setConfirmingId(null);
    try {
      const operationId = await recovery.beginOrReuseReversal(receipt.id);
      if (!isCurrent()) return;
      const updated = await postReverseCheckout({ operationId, checkoutId: receipt.id });
      if (!isCurrent()) return;
      if (updated.status !== "reversed") throw new Error("Checkout reversal response was incomplete.");
      queryClient.setQueryData<{ checkouts: CheckoutReceipt[]; limit: 100 }>(["host-checkouts"], (current) =>
        current ? { ...current, checkouts: current.checkouts.map((item) => item.id === updated.id ? updated : item) } : current,
      );
      queryClient.setQueryData(["checkout-receipt", submittedScope, updated.id], updated);
      let recoveryCleanupFailed = false;
      try {
        if (!isCurrent()) return;
        await recovery.finishReversal(receipt.id, operationId);
      } catch {
        recoveryCleanupFailed = true;
      }
      if (!isCurrent()) return;
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["cellar-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["host-inventory"] }),
        queryClient.invalidateQueries({ queryKey: ["wine-catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-options"] }),
        queryClient.invalidateQueries({ queryKey: ["cart-context"] }),
        queryClient.invalidateQueries({ queryKey: ["host-checkouts"] }),
        queryClient.invalidateQueries({ queryKey: ["host-telegram"] }),
      ]);
      if (!isCurrent()) return;
      setActionError("");
      setNotice(`Checkout for ${updated.guestName} reversed. Stock restored to original locations.${recoveryCleanupFailed ? " Saved retry key could not be cleared; history refreshed." : ""}`);
    } catch (error) {
      if (!isCurrent()) return;
      setActionError(errorMessage(error, "Reversal status is uncertain. Retry same checkout to check and finish safely."));
      if (errorStatus(error) === 401 || errorStatus(error) === 403) {
        if (principal) setRejectedPrincipal(principal);
        resetPrivateCart();
        queryClient.removeQueries({ queryKey: ["host-checkouts"] });
        queryClient.removeQueries({ queryKey: ["host-telegram"] });
        queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
        queryClient.removeQueries({ queryKey: ["cart-context"] });
      }
    } finally {
      if (isCurrent()) setWorkingId(null);
    }
  }

  async function clearResolvedRetry(receipt: CheckoutReceipt) {
    const submittedScope = hostScope;
    const operationId = recovery.reversals[receipt.id];
    if (!submittedScope || latestScopeRef.current !== submittedScope || !operationId || receipt.status !== "reversed") return;
    const isCurrent = () => latestScopeRef.current === submittedScope;
    try {
      if (!isCurrent()) return;
      await recovery.finishReversal(receipt.id, operationId);
      if (!isCurrent()) return;
      setActionError("");
      setNotice("Saved reversal retry cleared. Checkout already reversed.");
    } catch (error) {
      if (!isCurrent()) return;
      setActionError(errorMessage(error, "Saved retry could not be cleared. Refresh and try again."));
    }
  }

  const loadingAuth = authState.type === "loading";
  const contextLoading = authState.type === "authenticated" && !denied && (contextQuery.isPending || contextQuery.isFetching);
  const historyLoading = historyEnabled && (historyQuery.isPending || historyQuery.isFetching);

  function denyHostAccess() {
    if (principal) setRejectedPrincipal(principal);
    resetPrivateCart();
    queryClient.removeQueries({ queryKey: ["host-checkouts"] });
    queryClient.removeQueries({ queryKey: ["host-telegram"] });
    queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
    queryClient.removeQueries({ queryKey: ["cart-context"] });
  }

  return (
    <div className={styles.frame}>
      <CellarMenu>
          <Link to="/">Overview</Link>
          <Link to="/wines">Wine inventory</Link>
          <Link to="/host-dashboard">Host dashboard</Link>
          <span aria-current="page">Checkouts</span>
          <Link to="/host-access">Host access</Link>
        
      </CellarMenu>

      <main className={styles.main}>
        <div className={styles.topbar}>
          <span>HOST WORKSPACE</span>
          <span className={styles.privacy}><ShieldCheck size={15} aria-hidden="true" /> Private view</span>
        </div>
        <div className={styles.content}>
          <Link to="/host-dashboard" className={styles.backLink}><ArrowLeft size={15} aria-hidden="true" /> Host dashboard</Link>
          <p className={styles.eyebrow}>PICKUP HISTORY</p>
          <div className={styles.headingRow}>
            <div>
              <h1>Checkout records</h1>
              <p className={styles.intro}>Review pickups, share wine photos and instructions from your phone, or reverse a checkout after bottles return.</p>
            </div>
            {hostScope && (
              <button className={styles.refreshButton} type="button" onClick={() => { void historyQuery.refetch(); void telegramQuery.refetch(); }} disabled={historyQuery.isFetching || telegramQuery.isFetching}>
                <RefreshCw size={16} aria-hidden="true" /> Refresh
              </button>
            )}
          </div>

          {loadingAuth || contextLoading ? (
            <section className={styles.state} role="status" aria-live="polite">
              <Wine size={23} aria-hidden="true" /><h2>Checking host access</h2><p>Opening private checkout history…</p><div className={styles.loadingBar} />
            </section>
          ) : denied || authState.type === "unauthenticated" ? (
            <section className={`${styles.state} ${styles.gate}`}>
              <span className={styles.lockBadge}><LockKeyhole size={20} aria-hidden="true" /></span>
              <p className={styles.eyebrow}>HOST ACCESS REQUIRED</p>
              <h2>This history is private.</h2>
              <p>Sign in with the designated host account to review pickups and reverse a checkout.</p>
              <Link className={styles.signIn} to="/login">Host sign in <span aria-hidden="true">→</span></Link>
            </section>
          ) : contextQuery.isError ? (
            <section className={styles.state} role="alert">
              <h2>History access could not be checked</h2><p>{errorMessage(contextQuery.error, "Retry when connection returns.")}</p>
              <button className={styles.secondaryButton} type="button" onClick={() => void contextQuery.refetch()}>Retry access check</button>
            </section>
          ) : historyLoading ? (
            <section className={styles.state} role="status" aria-live="polite">
              <Wine size={23} aria-hidden="true" /><h2>Loading checkout records</h2><p>Checking current host access…</p><div className={styles.loadingBar} />
            </section>
          ) : historyQuery.isError ? (
            <section className={styles.state} role="alert">
              <h2>Checkout history unavailable</h2><p>{errorMessage(historyQuery.error, "Retry when connection returns.")}</p>
              <button className={styles.secondaryButton} type="button" onClick={() => void historyQuery.refetch()}>Retry history</button>
            </section>
          ) : (
            <>
              <div className={styles.countNote}>
                <strong>Showing up to latest {historyQuery.data?.limit ?? 100} checkouts.</strong>
                <span>Older records may be outside this list.</span>
              </div>
              <TelegramSettings
                status={telegramQuery.data ?? null}
                loading={telegramQuery.isPending || telegramQuery.isFetching}
                loadError={telegramQuery.isError}
                onRefresh={() => { void telegramQuery.refetch(); }}
                onAccessDenied={denyHostAccess}
              />
              {recovery.persistence === "memory" && <div className={styles.recoveryNotice} role="status">Browser storage unavailable. Reversal retry keys cannot be saved, so reversal stays disabled.</div>}
              {recovery.problem === "invalid" && <div className={styles.recoveryNotice} role="alert">Saved reversal recovery is invalid. Do not start a new reversal on this device.</div>}
              {actionError && <div className={styles.errorNotice} role="alert">{actionError}</div>}
              {notice && <div className={styles.successNotice} role="status">{notice}</div>}

              {checkouts.length === 0 ? (
                <section className={styles.empty}>
                  <span className={styles.iconBadge}><Wine size={20} aria-hidden="true" /></span>
                  <h2>No checkouts yet</h2>
                  <p>Completed guest pickups will appear here.</p>
                </section>
              ) : (
                <div className={styles.receiptList}>
                  {checkouts.map((receipt) => {
                    const operationId = recovery.reversals[receipt.id];
                    const isWorking = workingId === receipt.id;
                    const canStartReversal = receipt.status === "completed" && !operationId && recoveryReady && !busy;
                    const canRetryReversal = receipt.status === "completed" && Boolean(operationId) && recoveryReady && !busy;
                    return (
                      <article className={styles.receipt} key={receipt.id}>
                        <div className={styles.receiptHeader}>
                          <div>
                            <p className={styles.cardEyebrow}>GUEST PICKUP</p>
                            <h2>{receipt.guestName}</h2>
                            <p className={styles.date}>Completed {formatTimestamp(receipt.createdAt)} · {receipt.bottleCount} {receipt.bottleCount === 1 ? "bottle" : "bottles"}</p>
                          </div>
                          <span className={`${styles.statusBadge} ${receipt.status === "reversed" ? styles.statusReversed : styles.statusCompleted}`}>
                            {receipt.status === "reversed" ? "Reversed" : "Completed"}
                          </span>
                        </div>
                        <div className={styles.items} aria-label="Pickup locations">
                          {receipt.items.map((item, index) => (
                            <div className={styles.pickupRow} key={`${receipt.id}-${item.wineId}-${item.locationId}-${index}`}>
                              <div><strong>{wineLabel(item)}</strong><span>{item.fridge} · {item.shelf}</span></div>
                              <b>{item.quantity} {item.quantity === 1 ? "bottle" : "bottles"}</b>
                            </div>
                          ))}
                        </div>
                        {receipt.recipients.length > 0 && (
                          <p className={styles.recipients}><span>Recipients</span> {receipt.recipients.map((recipient) => recipient.displayName).join(", ")}</p>
                        )}
                        {receipt.status === "reversed" && (
                          <p className={styles.reversedAt}>Reversed {receipt.reversedAt ? formatTimestamp(receipt.reversedAt) : ""}</p>
                        )}

                        <TelegramDeliveryStatus
                          checkoutId={receipt.id}
                          event={receipt.status === "reversed" ? "reversal" : "checkout"}
                          delivery={telegramQuery.data?.deliveries.find((delivery) => delivery.checkoutId === receipt.id && delivery.event === (receipt.status === "reversed" ? "reversal" : "checkout")) ?? null}
                          telegramReady={Boolean(telegramQuery.data?.configured && telegramQuery.data.connected)}
                          loading={telegramQuery.isPending || telegramQuery.isFetching}
                          loadError={telegramQuery.isError}
                          onRefresh={() => { void telegramQuery.refetch(); }}
                          onAccessDenied={denyHostAccess}
                        />

                        {receipt.status === "completed" && !operationId && !busy && confirmingId !== receipt.id && (
                          <PickupShare key={`${hostScope}:${receipt.id}`} checkoutId={receipt.id} onAccessDenied={() => {
                            if (principal) setRejectedPrincipal(principal);
                            resetPrivateCart();
                            queryClient.removeQueries({ queryKey: ["host-checkouts"] });
                            queryClient.removeQueries({ queryKey: ["host-telegram"] });
                            queryClient.removeQueries({ queryKey: ["checkout-receipt"] });
                            queryClient.removeQueries({ queryKey: ["cart-context"] });
                          }} />
                        )}

                        {receipt.status === "completed" && operationId && (
                          <div className={styles.pendingRetry}>
                            <p>Reversal was confirmed earlier but result may be pending. Retry uses same saved operation.</p>
                            <button type="button" className={styles.reverseButton} disabled={!canRetryReversal || isWorking} onClick={() => void reverse(receipt)}>
                              <RotateCcw size={16} aria-hidden="true" /> {isWorking ? "Checking reversal…" : "Retry saved reversal"}
                            </button>
                          </div>
                        )}
                        {receipt.status === "reversed" && operationId && (
                          <button type="button" className={styles.secondaryButton} disabled={!recoveryReady || busy} onClick={() => void clearResolvedRetry(receipt)}>
                            Clear saved retry key
                          </button>
                        )}
                        {receipt.status === "completed" && !operationId && (
                          confirmingId === receipt.id ? (
                            <div className={styles.confirmPanel} role="group" aria-labelledby={`reverse-title-${receipt.id}`} aria-describedby={`reverse-desc-${receipt.id}`}>
                              <h3 id={`reverse-title-${receipt.id}`}>Confirm returned bottles</h3>
                              <p id={`reverse-desc-${receipt.id}`}>Only continue after all {receipt.bottleCount} bottles have physically returned to the listed fridge and shelf locations.</p>
                              <div className={styles.confirmActions}>
                                <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setConfirmingId(null)}>Keep checkout</button>
                                <button type="button" className={styles.reverseButton} disabled={!canStartReversal || isWorking} onClick={() => void reverse(receipt)}>
                                  <RotateCcw size={16} aria-hidden="true" /> {isWorking ? "Reversing…" : "Confirm return and reverse"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className={styles.reverseButton} disabled={!canStartReversal} onClick={() => { setActionError(""); setNotice(""); setConfirmingId(receipt.id); }}>
                              <RotateCcw size={16} aria-hidden="true" /> Reverse checkout
                            </button>
                          )
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
