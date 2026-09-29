import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getCheckoutShare } from "../endpoints/host/checkout-share_GET.schema";
import type { OutputType as CheckoutSharePacket } from "../endpoints/host/checkout-share_GET.schema";
import { formatPickupMessage } from "../helpers/pickupSharePolicy";
import { preparePickupFiles } from "../helpers/pickupShareClient";
import styles from "./PickupShare.module.css";

const FreshForMs = 60_000;

type PreparedPickup = {
  packet: CheckoutSharePacket;
  files: File[];
  urls: string[];
  preparedAt: number;
};

type Props = { checkoutId: string; onAccessDenied?: () => void; className?: string };

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function itemKey(item: { wineId: string; locationId: string }): string {
  return `${item.wineId}:${item.locationId}`;
}

export function PickupShare({ checkoutId, onAccessDenied, className }: Props) {
  const headingId = `pickup-share-title-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [prepared, setPrepared] = useState<PreparedPickup | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState("");
  const [errorText, setErrorText] = useState("");
  const generation = useRef(0);
  const latestCheckoutId = useRef(checkoutId);
  latestCheckoutId.current = checkoutId;
  const request = useRef<AbortController | null>(null);
  const preparedRef = useRef<PreparedPickup | null>(null);
  const expiry = useRef<number | null>(null);
  const sharingRef = useRef(false);

  const clearPrepared = useCallback((clearNotice = false) => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    if (expiry.current !== null) window.clearTimeout(expiry.current);
    expiry.current = null;
    const previous = preparedRef.current;
    preparedRef.current = null;
    previous?.urls.forEach((url) => URL.revokeObjectURL(url));
    setPrepared(null);
    setBusy(false);
    if (clearNotice) setNotice("");
  }, []);

  useEffect(() => {
    clearPrepared(true);
    setErrorText("");
    return () => {
      generation.current += 1;
      request.current?.abort();
      sharingRef.current = false;
      if (expiry.current !== null) window.clearTimeout(expiry.current);
      const previous = preparedRef.current;
      preparedRef.current = null;
      previous?.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [checkoutId, clearPrepared]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && !sharingRef.current && preparedRef.current) {
        clearPrepared(true);
        setNotice("Pickup images cleared when this page went into the background. Prepare them again before sharing.");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [clearPrepared]);

  async function prepareImages() {
    clearPrepared(true);
    setErrorText("");
    setBusy(true);
    const currentGeneration = generation.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      const packet = await getCheckoutShare(checkoutId, { signal: controller.signal });
      if (generation.current !== currentGeneration || controller.signal.aborted || latestCheckoutId.current !== checkoutId) return;
      if (packet.receipt.id !== checkoutId || packet.receipt.status !== "completed") {
        throw new Error(packet.receipt.status === "reversed" ? "This checkout was reversed. Pickup images are no longer available." : "Checkout details do not match this request.");
      }
      const files = await preparePickupFiles(packet, controller.signal);
      if (generation.current !== currentGeneration || controller.signal.aborted || latestCheckoutId.current !== checkoutId) return;
      const urls: string[] = [];
      try {
        for (const file of files) urls.push(URL.createObjectURL(file));
      } catch {
        urls.forEach((url) => URL.revokeObjectURL(url));
        throw new Error("Pickup images could not be prepared in this browser.");
      }
      const value: PreparedPickup = { packet, files, urls, preparedAt: Date.now() };
      preparedRef.current = value;
      setPrepared(value);
      const missingCount = packet.photos.filter((photo) => !photo.photoPath).length;
      setNotice(missingCount ? `${files.length} pickup image${files.length === 1 ? "" : "s"} prepared. ${missingCount} location${missingCount === 1 ? " has" : "s have"} no saved wine photo.` : `${files.length} pickup image${files.length === 1 ? "" : "s"} prepared.`);
      const expire = () => {
        if (sharingRef.current) {
          expiry.current = window.setTimeout(expire, 1000);
          return;
        }
        clearPrepared(true);
        setNotice("Pickup images expired. Prepare them again before sharing.");
      };
      expiry.current = window.setTimeout(expire, FreshForMs);
    } catch (error) {
      if (generation.current !== currentGeneration || controller.signal.aborted || latestCheckoutId.current !== checkoutId) return;
      if (statusOf(error) === 401 || statusOf(error) === 403) {
        clearPrepared(true);
        onAccessDenied?.();
        setErrorText("Host access expired. Sign in again to prepare pickup images.");
      } else {
        clearPrepared(true);
        setErrorText(messageOf(error, "Pickup images could not be prepared. Try again."));
      }
    } finally {
      if (generation.current === currentGeneration && latestCheckoutId.current === checkoutId) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function shareImages() {
    const current = preparedRef.current;
    if (!current || current.packet.receipt.id !== latestCheckoutId.current || current.files.length === 0 || Date.now() - current.preparedAt >= FreshForMs) {
      clearPrepared(true);
      setNotice("Pickup images expired. Prepare them again before sharing.");
      return;
    }
    if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
      setNotice("Image sharing is unavailable here. Download the images and copy pickup details below.");
      return;
    }
    let supported = false;
    try { supported = navigator.canShare({ files: current.files }); } catch { supported = false; }
    if (!supported) {
      setNotice("This browser cannot share image files. Download the images and copy pickup details below.");
      return;
    }

    // Call synchronously from this click so the OS share sheet keeps user activation.
    const currentGeneration = generation.current;
    const sharedCheckoutId = current.packet.receipt.id;
    let completed = false;
    sharingRef.current = true;
    setSharing(true);
    setErrorText("");
    let promise: Promise<void>;
    try {
      promise = navigator.share({ files: current.files, title: `Pickup ${current.packet.receipt.guestName}` });
    } catch (error) {
      sharingRef.current = false;
      setSharing(false);
      setErrorText(messageOf(error, "The share sheet could not be opened. Download the images and copy pickup details instead."));
      return;
    }
    void promise.then(() => {
      if (generation.current === currentGeneration && latestCheckoutId.current === sharedCheckoutId) {
        setNotice("Share sheet opened. Confirm recipients and tap Send in WhatsApp.");
        completed = true;
      }
    }).catch((error: unknown) => {
      if (generation.current !== currentGeneration || latestCheckoutId.current !== sharedCheckoutId) return;
      if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
        setNotice("Share cancelled. No delivery was confirmed.");
      } else {
        setErrorText(messageOf(error, "The share sheet could not be opened. Download the images and copy pickup details instead."));
      }
    }).finally(() => {
      sharingRef.current = false;
      if (generation.current === currentGeneration && latestCheckoutId.current === sharedCheckoutId) {
        setSharing(false);
        if (completed) clearPrepared(false);
      }
    });
  }

  async function copyDetails() {
    const current = preparedRef.current;
    if (!current) return;
    const currentGeneration = generation.current;
    const sharedCheckoutId = current.packet.receipt.id;
    try {
      await navigator.clipboard.writeText(formatPickupMessage(current.packet.receipt));
      if (generation.current === currentGeneration && latestCheckoutId.current === sharedCheckoutId) {
        setNotice("Pickup details copied. Choose recipients and send from WhatsApp.");
      }
    } catch {
      if (generation.current === currentGeneration && latestCheckoutId.current === sharedCheckoutId) {
        setErrorText("Clipboard access is unavailable. Select and copy pickup details from the preview.");
      }
    }
  }

  function preparedStillFresh(): boolean {
    const current = preparedRef.current;
    return Boolean(
      current && current.packet.receipt.id === latestCheckoutId.current &&
      Date.now() - current.preparedAt < FreshForMs,
    );
  }

  function expireAtAction(): boolean {
    if (preparedStillFresh()) return false;
    clearPrepared(true);
    setNotice("Pickup images expired. Prepare them again before sharing.");
    return true;
  }

  const activePrepared = prepared?.packet.receipt.id === checkoutId ? prepared : null;
  const missingPhotos = activePrepared?.packet.photos.filter((photo) => !photo.photoPath) ?? [];
  const preparedIsFresh = Boolean(activePrepared && Date.now() - activePrepared.preparedAt < FreshForMs);
  const shareCapable = (() => {
    if (!preparedIsFresh || typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try { return navigator.canShare({ files: activePrepared!.files }); } catch { return false; }
  })();

  return (
    <section className={`${styles.panel} ${className ?? ""}`} aria-labelledby={headingId}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>PICKUP IMAGES</p>
        <h2 id={headingId}>Prepare pickup details for sharing.</h2>
        <p>Choose WhatsApp and recipients in the share sheet, then tap Send. Details reflect preparation time; if a checkout changes, prepare again. Delivery is not confirmed here.</p>
      </header>

      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {errorText && <p className={styles.error} role="alert">{errorText}</p>}

      {!activePrepared && <button className={styles.primaryButton} type="button" disabled={busy || !checkoutId} onClick={() => void prepareImages()}>{busy ? "Preparing pickup images…" : "Prepare pickup images"}</button>}

      {activePrepared && (
        <>
          <div className={styles.summary}>
            <strong>{activePrepared.packet.receipt.guestName}</strong>
            <span>{activePrepared.packet.receipt.bottleCount} {activePrepared.packet.receipt.bottleCount === 1 ? "bottle" : "bottles"} · prepared {new Date(activePrepared.preparedAt).toLocaleTimeString()}</span>
            <span>WhatsApp sender uses the account selected on this device.</span>
          </div>

          <section className={styles.recipientSection} aria-label="Recipient checklist">
            <h3>Recipient checklist</h3>
            <p>Choose recipients separately in WhatsApp.</p>
            <ul className={styles.recipients}>{activePrepared.packet.receipt.recipients.map((recipient) => (
              <li key={recipient.id}><span className={styles.recipientCheck} aria-hidden="true" /> <span>{recipient.displayName}{recipient.isHost ? " · host" : ""}</span></li>
            ))}</ul>
          </section>

          {missingPhotos.length > 0 && (
            <section className={styles.missingSection} aria-label="Missing wine photos">
              <h3>Wine photos missing</h3>
              <p>Pickup details are available, but these locations have no saved wine photo.</p>
              <ul>{missingPhotos.map((photo) => {
                const item = activePrepared.packet.receipt.items.find((candidate) => itemKey(candidate) === itemKey(photo));
                return <li key={itemKey(photo)}>{item ? `${item.producer} · ${item.wineName} — ${item.fridge} · ${item.shelf}` : "A pickup location has no saved wine photo."}</li>;
              })}</ul>
            </section>
          )}

          {activePrepared.files.length > 0 ? (
            <div className={styles.imageGrid} aria-label="Prepared pickup images">
              {activePrepared.files.map((file, index) => (
                <figure className={styles.imageCard} key={`${file.name}-${index}`}>
                  <img src={activePrepared.urls[index]} alt={`Pickup image ${index + 1}: ${file.name}`} />
                  <figcaption>{file.name}</figcaption>
                  <a href={activePrepared.urls[index]} download={file.name} onClick={(event) => { if (expireAtAction()) event.preventDefault(); }}>Download image</a>
                </figure>
              ))}
            </div>
          ) : (
            <p className={styles.error}>No pickup images were available. Copy pickup details or ask the host to add wine photos.</p>
          )}

          <div className={styles.actions}>
            <button className={styles.primaryButton} type="button" onClick={shareImages} disabled={!preparedIsFresh || !shareCapable || sharing || activePrepared.files.length === 0}>{sharing ? "Opening share sheet…" : "Share pickup images"}</button>
            <button className={styles.secondaryButton} type="button" onClick={() => { if (!expireAtAction()) void copyDetails(); }} disabled={!preparedIsFresh}>Copy pickup details</button>
            <button className={styles.textButton} type="button" onClick={() => { clearPrepared(true); setErrorText(""); }}>Clear prepared images</button>
          </div>
          {!shareCapable && activePrepared.files.length > 0 && <p className={styles.helpText}>Image sharing is not supported here. Use Download image for each file, then copy pickup details.</p>}
          <details className={styles.details}>
            <summary>Pickup details</summary>
            <pre>{formatPickupMessage(activePrepared.packet.receipt)}</pre>
          </details>
        </>
      )}
    </section>
  );
}

export default PickupShare;
