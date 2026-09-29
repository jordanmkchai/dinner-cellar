import React, { useState } from "react";
import superjson from "superjson";
import styles from "./TelegramSettings.module.css";

export type TelegramDelivery = {
  checkoutId: string;
  event: "checkout" | "reversal";
  state: string;
  sent: number;
  total: number;
  error: string | null;
};

export type TelegramStatus = {
  configured: boolean;
  connected: boolean;
  botUsername: string | null;
  deliveries: TelegramDelivery[];
};

type TelegramApiError = Error & { status?: number; code?: string };

function apiError(status: number, code?: string): TelegramApiError {
  const error = new Error("Telegram request failed") as TelegramApiError;
  error.status = status;
  error.code = code;
  return error;
}

async function requestTelegram<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? superjson.stringify(body ?? {}) : undefined,
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const payload = superjson.parse<unknown>(await response.text());
      if (payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string") code = payload.code;
    } catch { /* Keep server details private. */ }
    throw apiError(response.status, code);
  }
  try {
    return superjson.parse<T>(await response.text());
  } catch {
    throw apiError(502, "INVALID_RESPONSE");
  }
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const value = await requestTelegram<unknown>("/_api/host/telegram", "GET");
  if (!value || typeof value !== "object") throw apiError(502, "INVALID_RESPONSE");
  const row = value as Record<string, unknown>;
  if (typeof row.configured !== "boolean" || typeof row.connected !== "boolean" ||
    !(row.botUsername === null || typeof row.botUsername === "string") || !Array.isArray(row.deliveries)) {
    throw apiError(502, "INVALID_RESPONSE");
  }
  const deliveries = row.deliveries.flatMap((item): TelegramDelivery[] => {
    if (!item || typeof item !== "object") return [];
    const delivery = item as Record<string, unknown>;
    if (typeof delivery.checkoutId !== "string" || (delivery.event !== "checkout" && delivery.event !== "reversal") ||
      typeof delivery.state !== "string" || typeof delivery.sent !== "number" || !Number.isFinite(delivery.sent) ||
      typeof delivery.total !== "number" || !Number.isFinite(delivery.total)) return [];
    return [{
      checkoutId: delivery.checkoutId,
      event: delivery.event,
      state: delivery.state,
      sent: Math.max(0, Math.floor(delivery.sent)),
      total: Math.max(0, Math.floor(delivery.total)),
      error: typeof delivery.error === "string" ? delivery.error : null,
    }];
  });
  return { configured: row.configured, connected: row.connected, botUsername: row.botUsername, deliveries };
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function safeError(error: unknown, action: string): string {
  const status = statusOf(error);
  if (status === 401 || status === 403) return "Host access expired. Sign in again, then retry.";
  if (status === 429) return "Telegram is receiving too many requests. Wait, then retry.";
  if (["TELEGRAM_NOT_CONFIGURED", "BOT_NOT_CONFIGURED"].includes(codeOf(error) ?? "")) {
    return "Telegram is not configured. Add the bot token in secure Floot secret settings, then refresh.";
  }
  if (codeOf(error) === "TELEGRAM_CREDENTIALS_REJECTED") {
    return "Telegram rejected the bot credentials. Update the token in secure Floot secret settings, then refresh.";
  }
  if (codeOf(error) === "TELEGRAM_NOT_CONNECTED") return "Connect the host Telegram account before retrying.";
  return `Could not ${action}. Refresh status and try again.`;
}

function safeConnectUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && ["t.me", "telegram.me"].includes(parsed.hostname.toLowerCase()) ? parsed.href : null;
  } catch {
    return null;
  }
}

type SettingsProps = {
  status: TelegramStatus | null;
  loading: boolean;
  loadError: boolean;
  onRefresh: () => void;
  onAccessDenied: () => void;
};

export function TelegramSettings({ status, loading, loadError, onRefresh, onAccessDenied }: SettingsProps) {
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [startLink, setStartLink] = useState<{ url: string; expiresAt: string } | null>(null);

  async function connect() {
    if (working) return;
    setWorking(true);
    setActionError("");
    setNotice("");
    setStartLink(null);
    try {
      const value = await requestTelegram<unknown>("/_api/host/telegram-connect", "POST", {});
      if (!value || typeof value !== "object") throw apiError(502, "INVALID_RESPONSE");
      const row = value as Record<string, unknown>;
      const url = safeConnectUrl(row.url);
      const expiresAt = typeof row.expiresAt === "string" && Number.isFinite(Date.parse(row.expiresAt)) ? row.expiresAt : null;
      if (!url || !expiresAt) throw apiError(502, "INVALID_RESPONSE");
      setStartLink({ url, expiresAt });
      setNotice("Open the one-time Telegram link, start the bot, then verify connection here.");
    } catch (error) {
      if (statusOf(error) === 401 || statusOf(error) === 403) onAccessDenied();
      setActionError(safeError(error, "create the Telegram connection link"));
    } finally {
      setWorking(false);
    }
  }

  async function verify() {
    if (working) return;
    setWorking(true);
    setActionError("");
    setNotice("");
    try {
      const result = await requestTelegram<unknown>("/_api/host/telegram-verify", "POST", {});
      if (!result || typeof result !== "object" || !("connected" in result) || typeof result.connected !== "boolean") {
        throw apiError(502, "INVALID_RESPONSE");
      }
      if (result.connected) {
        setStartLink(null);
        setNotice("Telegram connection verified. Automatic messages go to the host chat only.");
      } else {
        setNotice("No verified Telegram start yet. Open the current link in Telegram, tap Start, then verify again.");
      }
      onRefresh();
    } catch (error) {
      if (statusOf(error) === 401 || statusOf(error) === 403) onAccessDenied();
      setActionError(safeError(error, "verify Telegram connection"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="telegram-settings-title">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>HOST NOTIFICATIONS</p>
          <h2 id="telegram-settings-title">Telegram delivery</h2>
        </div>
        <button className={styles.textButton} type="button" onClick={onRefresh} disabled={loading || working}>Refresh status</button>
      </div>
      <p className={styles.explainer}>When connected, the bot sends a Telegram message to the host after checkout or reversal. Delivery status appears below; the host forwards details to guests. Checkout and stock do not depend on delivery.</p>
      {loading ? <p className={styles.statusLine} role="status">Checking Telegram connection…</p> : loadError ? (
        <p className={styles.error} role="alert">Telegram status could not be loaded. Retry after checking host access.</p>
      ) : !status ? (
        <p className={styles.statusLine} role="status">Telegram status is unavailable. Refresh to check configuration.</p>
      ) : status?.configured === false ? (
        <div className={styles.setupNote}>
          <strong>Telegram bot is not configured.</strong>
          <span>Add the bot token through secure Floot secret settings, then refresh. Never enter it here.</span>
        </div>
      ) : status?.connected ? (
        <div className={styles.connected}>
          <span className={styles.stateBadge}>Connected</span>
          {status.botUsername && <span className={styles.botName}>@{status.botUsername.replace(/^@/, "")}</span>}
          <span>Messages go to host Telegram only.</span>
        </div>
      ) : (
        <div className={styles.connectActions}>
          <span className={styles.stateBadgeMuted}>Not connected</span>
          <button className={styles.primaryButton} type="button" onClick={() => void connect()} disabled={working || loading}>
            {working ? "Working…" : "Connect Telegram"}
          </button>
        </div>
      )}
      {startLink && !status?.connected && (
        <div className={styles.startCard}>
          <p>This one-time start link expires {new Date(startLink.expiresAt).toLocaleString()}.</p>
          <a className={styles.primaryButton} href={startLink.url} target="_blank" rel="noopener noreferrer">Open Telegram bot</a>
          <button className={styles.secondaryButton} type="button" onClick={() => void verify()} disabled={working}>
            {working ? "Checking…" : "Verify connection"}
          </button>
        </div>
      )}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </section>
  );
}

type DeliveryProps = {
  checkoutId: string;
  event: "checkout" | "reversal";
  delivery: TelegramDelivery | null;
  telegramReady: boolean;
  loading: boolean;
  loadError: boolean;
  onRefresh: () => void;
  onAccessDenied: () => void;
};

export function TelegramDeliveryStatus({ checkoutId, event, delivery, telegramReady, loading, loadError, onRefresh, onAccessDenied }: DeliveryProps) {
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const state = delivery?.state.toLowerCase() ?? "missing";
  const unknown = state === "unknown";
  const sending = ["sending", "queued", "in_progress", "processing"].includes(state);
  const retryable = !loading && !loadError && ["pending", "failed", "unknown"].includes(state);
  const label = loading ? "Checking status" : loadError ? "Status unavailable" : state === "sent" ? "Sent to host chat" :
    sending ? "Sending to host chat" : state === "pending" ? "Delivery pending" : state === "failed" ? "Delivery failed" :
      state === "unknown" ? "Result unknown" : state === "missing" ? "No delivery record" : "Delivery status unavailable";

  async function retry() {
    if (!delivery || !retryable || !telegramReady || (unknown && !acknowledgeDuplicate) || working) return;
    setWorking(true);
    setActionError("");
    setNotice("");
    try {
      await requestTelegram<unknown>("/_api/host/telegram-retry", "POST", {
        checkoutId,
        event,
        acknowledgePossibleDuplicate: unknown && acknowledgeDuplicate,
      });
      setNotice("Retry requested for host delivery. Refresh to check its status.");
      setAcknowledgeDuplicate(false);
      onRefresh();
    } catch (error) {
      if (statusOf(error) === 401 || statusOf(error) === 403) onAccessDenied();
      setActionError(safeError(error, "retry host delivery"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={styles.delivery} aria-label={`${event === "checkout" ? "Checkout" : "Reversal"} Telegram delivery`}>
      <div className={styles.deliveryTop}>
        <strong>{event === "checkout" ? "Checkout message" : "Reversal message"}</strong>
        <span className={`${styles.deliveryState} ${state === "sent" ? styles.deliverySent : state === "failed" ? styles.deliveryFailed : ""}`}>{label}</span>
      </div>
      {loading ? <p>Checking host message status…</p> : loadError ? <p>Refresh Telegram status to check delivery.</p> :
        delivery ? <p>{delivery.sent} of {delivery.total} host messages confirmed.</p> : <p>No automatic Telegram delivery record for this event.</p>}
      {sending && <p className={styles.deliveryHint}>Telegram is processing the host message. Refresh status to check again.</p>}
      {state === "failed" && <p className={styles.deliveryHint}>Telegram did not confirm delivery. Retry sends to the host only.</p>}
      {delivery?.error && <p className={styles.deliveryHint}>{delivery.error}</p>}
      {unknown && <p className={styles.deliveryHint}>Telegram result is uncertain. A retry may send a duplicate to the host.</p>}
      {retryable && !telegramReady && <p className={styles.deliveryHint}>Connect Telegram before retrying host delivery.</p>}
      {unknown && (
        <label className={styles.duplicateAck}>
          <input type="checkbox" checked={acknowledgeDuplicate} onChange={(eventValue) => setAcknowledgeDuplicate(eventValue.currentTarget.checked)} />
          <span>Message may already be in Telegram; resend anyway</span>
        </label>
      )}
      {!loading && !loadError && delivery && ["pending", "failed", "unknown"].includes(state) && (
        <button className={styles.secondaryButton} type="button" onClick={() => void retry()} disabled={!telegramReady || working || (unknown && !acknowledgeDuplicate)}>
          {working ? "Retrying…" : telegramReady ? "Retry host message" : "Connect Telegram to retry"}
        </button>
      )}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </section>
  );
}
