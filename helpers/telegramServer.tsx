import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { sql } from "kysely";
import { db } from "./db";
import { PolicyError } from "./inventoryPolicy";
import { type InventoryPrincipal, type InventoryTransaction } from "./inventoryServer";
import {
  createTelegramParts,
  parseTelegramUpdates,
  sendTelegramOutcome,
  telegramPhotoUrl,
  type TelegramEnqueueInput,
  type TelegramEvent,
  type TelegramPartOutcome,
} from "./telegramPolicy";

const DELIVERY_LIMIT = 100;
const DISPATCH_LIMIT_MS = 20_000;
const BOT_REQUEST_LIMIT_MS = 4_500;
const SEND_INTERVAL_MS = 1_100;
const STALE_SENDING_MS = 30_000;
const TELEGRAM_API = "https://api.telegram.org/bot";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/;

type SettingsRow = {
  hostChatId: string | null;
  botUsername: string | null;
  nonceHash: string | null;
  nonceExpiresAt: Date | string | null;
  nextSendAt: Date | string | null;
};
type DeliveryRow = {
  id: string;
  checkoutId: string;
  event: TelegramEvent;
  state: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type PartRow = {
  id: string;
  deliveryId: string;
  partIndex: number;
  kind: "text" | "photo";
  content: string;
  photoPath: string | null;
  state: string;
  errorCode: string | null;
  attemptCount: number;
  startedAt: Date | string | null;
};
type ApiResponse = { httpStatus: number; body: unknown } | { networkError: true };
type DispatchResult = {
  checkoutId: string;
  event: TelegramEvent;
  state: string;
  sent: number;
  total: number;
  error: string | null;
};

function requireHost(principal: InventoryPrincipal): asserts principal is Extract<InventoryPrincipal, { role: "host" }> {
  if (principal.role !== "host") throw new PolicyError("Host access required", 401, "HOST_REQUIRED");
}

function tokenConfigured(): boolean {
  const token = (process.env as unknown as Record<string, string | undefined>).TELEGRAM_BOT_TOKEN;
  return typeof token === "string" && BOT_TOKEN.test(token);
}

function requireToken(): string {
  const token = (process.env as unknown as Record<string, string | undefined>).TELEGRAM_BOT_TOKEN;
  if (typeof token !== "string" || !BOT_TOKEN.test(token)) {
    throw new PolicyError("Telegram bot is not configured", 503, "TELEGRAM_NOT_CONFIGURED");
  }
  return token;
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_$]{1,80}$/.test(error.name) ? error.name : "UnknownError";
}

function dateMillis(value: Date | string | null): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBotResponse(value: unknown): Record<string, unknown> | null {
  const outer = parseRecord(value);
  return outer?.ok === true ? parseRecord(outer.result) : null;
}

async function requestBotApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = BOT_REQUEST_LIMIT_MS,
): Promise<ApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    let body: unknown = null;
    try { body = JSON.parse(await response.text()) as unknown; }
    catch { body = null; }
    return { httpStatus: response.status, body };
  } catch {
    return { networkError: true };
  } finally {
    clearTimeout(timeout);
  }
}

function apiResult(response: ApiResponse, code = "TELEGRAM_API_UNAVAILABLE"): Record<string, unknown> {
  if ("networkError" in response || response.httpStatus < 200 || response.httpStatus >= 300) {
    throw new PolicyError("Telegram could not be reached", 503, code);
  }
  const body = parseRecord(response.body);
  if (!body || body.ok !== true) throw new PolicyError("Telegram rejected the request", 502, "TELEGRAM_API_REJECTED");
  const result = parseRecord(body.result);
  if (!result) throw new PolicyError("Telegram response was incomplete", 502, "TELEGRAM_RESPONSE_INVALID");
  return result;
}

async function ensureBotReady(token: string): Promise<string> {
  const meResponse = await requestBotApi(token, "getMe", {});
  const me = apiResult(meResponse);
  if (me.is_bot !== true || typeof me.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(me.username)) {
    throw new PolicyError("Telegram bot identity is invalid", 503, "TELEGRAM_BOT_INVALID");
  }
  const webhookResponse = await requestBotApi(token, "getWebhookInfo", {});
  const webhook = apiResult(webhookResponse);
  if (typeof webhook.url !== "string") throw new PolicyError("Telegram webhook status is invalid", 503, "TELEGRAM_WEBHOOK_STATUS_INVALID");
  if (webhook.url.length > 0) throw new PolicyError("Telegram bot has a webhook configured; remove it manually before connecting", 409, "TELEGRAM_WEBHOOK_ACTIVE");
  return me.username;
}

async function settingsRow(): Promise<SettingsRow> {
  const row = await db.selectFrom("telegramHostSettings")
    .select(["hostChatId", "botUsername", "nonceHash", "nonceExpiresAt", "nextSendAt"])
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!row) throw new PolicyError("Telegram settings are unavailable", 503, "TELEGRAM_SETTINGS_UNAVAILABLE");
  return row as SettingsRow;
}

async function setDeliveryState(trx: InventoryTransaction, deliveryId: string): Promise<string> {
  await trx.selectFrom("telegramDeliveries")
    .select(["id"])
    .where("id", "=", deliveryId)
    .forUpdate()
    .executeTakeFirst();
  const rows = await trx.selectFrom("telegramDeliveryParts")
    .select(["state"])
    .where("deliveryId", "=", deliveryId)
    .execute() as Array<{ state: string }>;
  const states = rows.map((row) => row.state);
  let state = "pending";
  if (!states.length) state = "failed";
  else if (states.includes("unknown")) state = "unknown";
  else if (states.includes("sending")) state = "sending";
  else if (states.includes("pending")) state = "pending";
  else if (states.includes("failed")) state = "failed";
  else if (states.every((value) => value === "sent")) state = "sent";
  await trx.updateTable("telegramDeliveries")
    .set({ state, updatedAt: new Date() })
    .where("id", "=", deliveryId)
    .execute();
  return state;
}

async function suppressPendingCheckoutParts(trx: InventoryTransaction, checkoutId: string): Promise<void> {
  const prior = await trx.selectFrom("telegramDeliveries")
    .select(["id"])
    .where("checkoutId", "=", checkoutId)
    .where("event", "=", "checkout")
    .forUpdate()
    .executeTakeFirst();
  if (!prior) return;
  const deliveryId = (prior as { id: string }).id;
  const now = new Date();
  await trx.updateTable("telegramDeliveryParts")
    .set({ state: "failed", errorCode: "SUPPRESSED_BY_REVERSAL", updatedAt: now })
    .where("deliveryId", "=", deliveryId)
    .where("state", "=", "pending")
    .execute();
  await trx.updateTable("telegramDeliveryParts")
    .set({ state: "unknown", errorCode: "IN_FLIGHT_AT_REVERSAL", updatedAt: now })
    .where("deliveryId", "=", deliveryId)
    .where("state", "=", "sending")
    .execute();
  await setDeliveryState(trx, deliveryId);
}

export async function enqueueTelegram(trx: InventoryTransaction, input: TelegramEnqueueInput): Promise<void> {
  if (input.event === "reversal") await suppressPendingCheckoutParts(trx, input.checkoutId.toLowerCase());
  const parts = createTelegramParts(input);
  const id = randomUUID();
  const inserted = await trx.insertInto("telegramDeliveries").values({
    id,
    checkoutId: input.checkoutId.toLowerCase(),
    event: input.event,
    state: "pending",
    guestName: input.guestName,
    recipientNames: input.recipientNames,
    partCount: parts.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflict((conflict) => conflict.columns(["checkoutId", "event"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) return;
  await trx.insertInto("telegramDeliveryParts").values(parts.map((part, partIndex) => ({
    id: randomUUID(),
    deliveryId: id,
    partIndex,
    kind: part.kind,
    content: part.content,
    photoPath: part.photoPath,
    state: "pending",
    errorCode: null,
    attemptCount: 0,
    startedAt: null,
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))).execute();
}

export async function beginTelegramConnection(
  principal: InventoryPrincipal,
): Promise<{ url: string; expiresAt: string }> {
  requireHost(principal);
  const token = requireToken();
  const username = await ensureBotReady(token);
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const nonceHash = createHash("sha256").update(nonce, "utf8").digest("hex");
  const updated = await db.updateTable("telegramHostSettings")
    .set({ botUsername: username, nonceHash, nonceExpiresAt: expiresAt, updatedAt: new Date() })
    .where("id", "=", 1)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) !== 1) {
    throw new PolicyError("Telegram settings are unavailable", 503, "TELEGRAM_SETTINGS_UNAVAILABLE");
  }
  return { url: `https://t.me/${username}?start=${nonce}`, expiresAt: expiresAt.toISOString() };
}

function nonceMatches(candidate: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(candidate) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = createHash("sha256").update(candidate, "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

export async function verifyTelegramConnection(
  principal: InventoryPrincipal,
): Promise<{ connected: boolean }> {
  requireHost(principal);
  const settings = await settingsRow();
  if (settings.hostChatId) return { connected: true };
  if (!settings.nonceHash || !settings.nonceExpiresAt) return { connected: false };
  const expiresAt = dateMillis(settings.nonceExpiresAt);
  if (expiresAt === null || expiresAt <= Date.now()) {
    await db.updateTable("telegramHostSettings")
      .set({ nonceHash: null, nonceExpiresAt: null, updatedAt: new Date() })
      .where("id", "=", 1)
      .where("nonceHash", "=", settings.nonceHash)
      .execute();
    throw new PolicyError("Telegram start link expired. Create a new link.", 410, "TELEGRAM_LINK_EXPIRED");
  }

  const token = requireToken();
  const username = await ensureBotReady(token);
  const updatesResponse = await requestBotApi(token, "getUpdates", { timeout: 0, allowed_updates: ["message"] });
  if ("networkError" in updatesResponse || updatesResponse.httpStatus < 200 || updatesResponse.httpStatus >= 300) {
    throw new PolicyError("Telegram updates are unavailable", 503, "TELEGRAM_UPDATES_UNAVAILABLE");
  }
  const updates = parseTelegramUpdates(updatesResponse.body);
  if (!updates) throw new PolicyError("Telegram updates were invalid", 502, "TELEGRAM_UPDATES_INVALID");

  let matchedChatId: string | null = null;
  const startPattern = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{43})$/;
  for (const value of updates) {
    const update = parseRecord(value);
    const message = parseRecord(update?.message);
    const chat = parseRecord(message?.chat);
    if (chat?.type !== "private" || typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) || chat.id <= 0 || typeof message?.text !== "string") continue;
    const match = startPattern.exec(message.text);
    if (match && nonceMatches(match[1], settings.nonceHash)) {
      matchedChatId = String(chat.id);
      break;
    }
  }
  if (!matchedChatId) return { connected: false };

  const connected = await db.updateTable("telegramHostSettings")
    .set({
      hostChatId: matchedChatId,
      botUsername: username,
      nonceHash: null,
      nonceExpiresAt: null,
      updatedAt: new Date(),
    })
    .where("id", "=", 1)
    .where("nonceHash", "=", settings.nonceHash)
    .where("nonceExpiresAt", ">", new Date())
    .executeTakeFirst();
  if (Number(connected.numUpdatedRows ?? 0) !== 1) {
    throw new PolicyError("Telegram link expired or was replaced", 409, "TELEGRAM_LINK_CHANGED");
  }
  const refreshed = await settingsRow();
  return { connected: Boolean(refreshed.hostChatId) };
}

function userFacingError(code: string | null): string | null {
  if (!code) return null;
  const messages: Record<string, string> = {
    TELEGRAM_NOT_CONFIGURED: "Bot token is not configured.",
    TELEGRAM_NOT_CONNECTED: "Host Telegram chat is not connected.",
    TELEGRAM_CREDENTIALS_REJECTED: "Bot token was rejected. Check secure configuration.",
    TELEGRAM_RATE_LIMITED: "Telegram rate limited delivery. Wait, then retry.",
    TELEGRAM_REJECTED: "Telegram rejected a message. Check photo limits and retry.",
    TELEGRAM_NETWORK_UNCERTAIN: "Telegram response was not received; a message may have arrived.",
    TELEGRAM_RESPONSE_UNCERTAIN: "Telegram response was unclear; a message may have arrived.",
    DISPATCH_DEADLINE: "Some messages remain pending. Retry from host delivery status.",
    SUPPRESSED_BY_REVERSAL: "Pickup message was suppressed after checkout reversal.",
    IN_FLIGHT_AT_REVERSAL: "A message was in flight during reversal; check Telegram before retrying.",
    TELEGRAM_PHOTO_PATH_UNSAFE: "Photo path was skipped for safety.",
  };
  return messages[code] ?? "Telegram delivery needs host attention.";
}

async function settleStaleSendingParts(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_SENDING_MS);
  const stale = await db.selectFrom("telegramDeliveryParts")
    .select(["id", "deliveryId"])
    .where("state", "=", "sending")
    .where("startedAt", "<", cutoff)
    .orderBy("deliveryId")
    .orderBy("id")
    .execute() as Array<{ id: string; deliveryId: string }>;
  if (!stale.length) return;
  await db.transaction().execute(async (trx) => {
    for (const part of stale) {
      await trx.selectFrom("telegramDeliveries")
        .select(["id"])
        .where("id", "=", part.deliveryId)
        .forUpdate()
        .executeTakeFirst();
      await trx.updateTable("telegramDeliveryParts")
        .set({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN", updatedAt: new Date() })
        .where("id", "=", part.id)
        .where("state", "=", "sending")
        .where("startedAt", "<", cutoff)
        .execute();
      await setDeliveryState(trx, part.deliveryId);
    }
  });
}

export async function getTelegramStatus(principal: InventoryPrincipal): Promise<{
  configured: boolean;
  connected: boolean;
  botUsername: string | null;
  deliveries: Array<{ checkoutId: string; event: TelegramEvent; state: string; sent: number; total: number; error: string | null }>;
}> {
  requireHost(principal);
  await settleStaleSendingParts();
  const settings = await settingsRow();
  const deliveries = await db.selectFrom("telegramDeliveries")
    .select(["id", "checkoutId", "event", "state", "createdAt", "updatedAt"])
    .orderBy("createdAt", "desc")
    .limit(DELIVERY_LIMIT * 2)
    .execute() as DeliveryRow[];
  const parts = deliveries.length
    ? await db.selectFrom("telegramDeliveryParts")
        .select(["deliveryId", "state", "errorCode"])
        .where("deliveryId", "in", deliveries.map((delivery) => delivery.id))
        .execute() as Array<{ deliveryId: string; state: string; errorCode: string | null }>
    : [];
  return {
    configured: tokenConfigured(),
    connected: Boolean(settings.hostChatId),
    botUsername: settings.botUsername,
    deliveries: deliveries.map((delivery) => {
      const rows = parts.filter((part) => part.deliveryId === delivery.id);
      const state = rows.some((part) => part.state === "unknown") ? "unknown"
        : rows.some((part) => part.state === "sending") ? "sending"
        : rows.some((part) => part.state === "pending") ? "pending"
        : rows.some((part) => part.state === "failed") ? "failed" : "sent";
      const errorCode = rows.find((part) => part.state === "unknown")?.errorCode ??
        rows.find((part) => part.state === "failed")?.errorCode ?? null;
      return {
        checkoutId: delivery.checkoutId,
        event: delivery.event,
        state,
        sent: rows.filter((part) => part.state === "sent").length,
        total: rows.length,
        error: userFacingError(errorCode),
      };
    }),
  };
}

async function refreshDeliveryState(deliveryId: string): Promise<void> {
  await db.transaction().execute((trx) => setDeliveryState(trx, deliveryId));
}

async function markPendingFailed(deliveryId: string, code: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("telegramDeliveries")
      .select(["id"])
      .where("id", "=", deliveryId)
      .forUpdate()
      .executeTakeFirst();
    await trx.updateTable("telegramDeliveryParts")
      .set({ state: "failed", errorCode: code, updatedAt: new Date() })
      .where("deliveryId", "=", deliveryId)
      .where("state", "=", "pending")
      .execute();
    await setDeliveryState(trx, deliveryId);
  });
}

async function currentDelivery(checkoutId: string, event: TelegramEvent): Promise<DeliveryRow | undefined> {
  return await db.selectFrom("telegramDeliveries")
    .select(["id", "checkoutId", "event", "state", "createdAt", "updatedAt"])
    .where("checkoutId", "=", checkoutId)
    .where("event", "=", event)
    .executeTakeFirst() as DeliveryRow | undefined;
}

async function claimNextPart(deliveryId: string, event: TelegramEvent, checkoutId: string): Promise<PartRow | null> {
  return await db.transaction().execute(async (trx) => {
    const delivery = await trx.selectFrom("telegramDeliveries")
      .select(["id"])
      .where("id", "=", deliveryId)
      .forUpdate()
      .executeTakeFirst();
    if (!delivery) return null;
    const inFlight = await trx.selectFrom("telegramDeliveryParts")
      .select(["id"])
      .where("deliveryId", "=", deliveryId)
      .where("state", "=", "sending")
      .forUpdate()
      .executeTakeFirst();
    if (inFlight) return null;
    if (event === "checkout") {
      const checkout = await trx.selectFrom("checkouts").select(["status"]).where("id", "=", checkoutId).executeTakeFirst();
      if (checkout?.status === "reversed") {
        await trx.updateTable("telegramDeliveryParts")
          .set({ state: "failed", errorCode: "SUPPRESSED_BY_REVERSAL", updatedAt: new Date() })
          .where("deliveryId", "=", deliveryId)
          .where("state", "=", "pending")
          .execute();
        await setDeliveryState(trx, deliveryId);
        return null;
      }
    }
    const part = await trx.selectFrom("telegramDeliveryParts")
      .select(["id", "deliveryId", "partIndex", "kind", "content", "photoPath", "state", "errorCode", "attemptCount", "startedAt"])
      .where("deliveryId", "=", deliveryId)
      .where("state", "=", "pending")
      .orderBy("partIndex")
      .forUpdate()
      .executeTakeFirst() as PartRow | undefined;
    if (!part) return null;
    await trx.updateTable("telegramDeliveryParts")
      .set({
        state: "sending",
        errorCode: null,
        attemptCount: sql`attempt_count + 1`,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", part.id)
      .where("state", "=", "pending")
      .execute();
    await trx.updateTable("telegramDeliveries")
      .set({ state: "sending", updatedAt: new Date() })
      .where("id", "=", deliveryId)
      .execute();
    return { ...part, state: "sending", attemptCount: part.attemptCount + 1 };
  });
}

async function reserveSendSlot(deadline: number): Promise<number | null> {
  return await db.transaction().execute(async (trx) => {
    const settings = await trx.selectFrom("telegramHostSettings")
      .select(["nextSendAt"])
      .where("id", "=", 1)
      .forUpdate()
      .executeTakeFirst() as Pick<SettingsRow, "nextSendAt"> | undefined;
    if (!settings) return null;
    const now = Date.now();
    const next = dateMillis(settings.nextSendAt);
    const slot = Math.max(now, next ?? now);
    if (slot >= deadline) return null;
    await trx.updateTable("telegramHostSettings")
      .set({ nextSendAt: new Date(slot + SEND_INTERVAL_MS), updatedAt: new Date() })
      .where("id", "=", 1)
      .execute();
    return slot;
  });
}

async function revertPartToPending(partId: string, deliveryId: string, attemptCount: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("telegramDeliveries")
      .select(["id"])
      .where("id", "=", deliveryId)
      .forUpdate()
      .executeTakeFirst();
    await trx.updateTable("telegramDeliveryParts")
      .set({ state: "pending", errorCode: null, startedAt: null, updatedAt: new Date() })
      .where("id", "=", partId)
      .where("state", "=", "sending")
      .where("attemptCount", "=", attemptCount)
      .execute();
    await setDeliveryState(trx, deliveryId);
  });
}

async function settlePart(part: PartRow, deliveryId: string, outcome: TelegramPartOutcome): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("telegramDeliveries")
      .select(["id"])
      .where("id", "=", deliveryId)
      .forUpdate()
      .executeTakeFirst();
    const now = new Date();
    await trx.updateTable("telegramDeliveryParts")
      .set({
        state: outcome.state,
        errorCode: outcome.errorCode,
        sentAt: outcome.state === "sent" ? now : null,
        updatedAt: now,
      })
      .where("id", "=", part.id)
      .where("state", "in", ["sending", "unknown"])
      .where("attemptCount", "=", part.attemptCount)
      .execute();
    await setDeliveryState(trx, deliveryId);
  });
}

async function isCheckoutReversed(checkoutId: string): Promise<boolean> {
  const row = await db.selectFrom("checkouts").select(["status"]).where("id", "=", checkoutId).executeTakeFirst();
  return row?.status === "reversed";
}

async function sendPart(
  token: string,
  chatId: string,
  part: PartRow,
  requestOrigin: string,
  timeoutMs: number,
): Promise<TelegramPartOutcome> {
  let method: "sendMessage" | "sendPhoto";
  let body: Record<string, unknown>;
  if (part.kind === "photo") {
    let photo: string;
    try {
      if (!part.photoPath) throw new Error("missing path");
      photo = telegramPhotoUrl(part.photoPath, requestOrigin);
    } catch {
      return { state: "failed", errorCode: "TELEGRAM_PHOTO_PATH_UNSAFE" };
    }
    method = "sendPhoto";
    body = { chat_id: chatId, photo, caption: part.content };
  } else {
    method = "sendMessage";
    body = { chat_id: chatId, text: part.content };
  }
  return await sendTelegramOutcome(fetch, token, method, body, timeoutMs);
}

async function dispatchInternal(
  checkoutId: string,
  event: TelegramEvent,
  requestOrigin: string,
): Promise<DispatchResult> {
  if (!UUID.test(checkoutId)) throw new PolicyError("Checkout delivery not found", 404, "TELEGRAM_DELIVERY_NOT_FOUND");
  const normalizedId = checkoutId.toLowerCase();
  const delivery = await currentDelivery(normalizedId, event);
  if (!delivery) throw new PolicyError("Checkout delivery not found", 404, "TELEGRAM_DELIVERY_NOT_FOUND");
  const settings = await settingsRow();
  if (!tokenConfigured()) {
    await markPendingFailed(delivery.id, "TELEGRAM_NOT_CONFIGURED");
  } else if (!settings.hostChatId) {
    await markPendingFailed(delivery.id, "TELEGRAM_NOT_CONNECTED");
  } else {
    const token = requireToken();
    const deadline = Date.now() + DISPATCH_LIMIT_MS;
    while (Date.now() < deadline) {
      const part = await claimNextPart(delivery.id, event, normalizedId);
      if (!part) break;
      const slot = await reserveSendSlot(deadline);
      if (slot === null) {
        await revertPartToPending(part.id, delivery.id, part.attemptCount);
        break;
      }
      const waitMs = slot - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (Date.now() >= deadline) {
        await revertPartToPending(part.id, delivery.id, part.attemptCount);
        break;
      }
      if (event === "checkout" && await isCheckoutReversed(normalizedId)) {
        await db.transaction().execute(async (trx) => {
          await trx.selectFrom("telegramDeliveries")
            .select(["id"])
            .where("id", "=", delivery.id)
            .forUpdate()
            .executeTakeFirst();
          await trx.updateTable("telegramDeliveryParts")
            .set({ state: "failed", errorCode: "SUPPRESSED_BY_REVERSAL", updatedAt: new Date() })
            .where("id", "=", part.id)
            .where("state", "=", "sending")
            .where("attemptCount", "=", part.attemptCount)
            .execute();
          await setDeliveryState(trx, delivery.id);
        });
        break;
      }
      const remaining = Math.max(1, Math.min(BOT_REQUEST_LIMIT_MS, deadline - Date.now()));
      const outcome = await sendPart(token, settings.hostChatId, part, requestOrigin, remaining);
      await settlePart(part, delivery.id, outcome);
      if (outcome.state === "failed" &&
          (outcome.errorCode === "TELEGRAM_CREDENTIALS_REJECTED" || outcome.errorCode === "TELEGRAM_RATE_LIMITED")) {
        await markPendingFailed(delivery.id, outcome.errorCode);
        break;
      }
    }
  }
  await refreshDeliveryState(delivery.id);
  const status = await db.selectFrom("telegramDeliveries")
    .select(["state"])
    .where("id", "=", delivery.id)
    .executeTakeFirst();
  const partRows = await db.selectFrom("telegramDeliveryParts")
    .select(["state", "errorCode"])
    .where("deliveryId", "=", delivery.id)
    .execute() as Array<{ state: string; errorCode: string | null }>;
  const errorCode = partRows.find((part) => part.state === "unknown")?.errorCode ??
    partRows.find((part) => part.state === "failed")?.errorCode ?? null;
  return {
    checkoutId: normalizedId,
    event,
    state: status?.state ?? "failed",
    sent: partRows.filter((part) => part.state === "sent").length,
    total: partRows.length,
    error: userFacingError(errorCode),
  };
}

export async function dispatchTelegram(
  checkoutId: string,
  event: TelegramEvent,
  requestOrigin: string,
): Promise<DispatchResult> {
  try {
    return await dispatchInternal(checkoutId, event, requestOrigin);
  } catch (error) {
    console.error("Telegram dispatch failed", {
      errorClass: safeErrorClass(error),
      ...(safeErrorCode(error) ? { code: safeErrorCode(error) } : {}),
    });
    throw error;
  }
}

export async function retryTelegram(
  principal: InventoryPrincipal,
  requestOrigin: string,
  checkoutId: string,
  event: TelegramEvent,
  acknowledgePossibleDuplicate: boolean,
): Promise<DispatchResult> {
  requireHost(principal);
  if (!UUID.test(checkoutId) || (event !== "checkout" && event !== "reversal")) {
    throw new PolicyError("Checkout delivery not found", 404, "TELEGRAM_DELIVERY_NOT_FOUND");
  }
  await settleStaleSendingParts();
  const normalizedId = checkoutId.toLowerCase();
  const delivery = await currentDelivery(normalizedId, event);
  if (!delivery) throw new PolicyError("Checkout delivery not found", 404, "TELEGRAM_DELIVERY_NOT_FOUND");
  if (event === "checkout" && await isCheckoutReversed(normalizedId)) {
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom("telegramDeliveries")
        .select(["id"])
        .where("id", "=", delivery.id)
        .forUpdate()
        .executeTakeFirst();
      await trx.updateTable("telegramDeliveryParts")
        .set({ state: "failed", errorCode: "SUPPRESSED_BY_REVERSAL", updatedAt: new Date() })
        .where("deliveryId", "=", delivery.id)
        .where("state", "=", "pending")
        .execute();
      await setDeliveryState(trx, delivery.id);
    });
    return dispatchInternal(normalizedId, event, requestOrigin);
  }

  await db.transaction().execute(async (trx) => {
    const locked = await trx.selectFrom("telegramDeliveries")
      .select(["id"])
      .where("id", "=", delivery.id)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw new PolicyError("Checkout delivery not found", 404, "TELEGRAM_DELIVERY_NOT_FOUND");
    const rows = await trx.selectFrom("telegramDeliveryParts")
      .select(["id", "state", "errorCode"])
      .where("deliveryId", "=", delivery.id)
      .forUpdate()
      .execute() as Array<{ id: string; state: string; errorCode: string | null }>;
    if (rows.some((row) => row.state === "sending")) {
      throw new PolicyError("Telegram delivery is still running", 409, "TELEGRAM_DELIVERY_IN_PROGRESS");
    }
    if (rows.some((row) => row.state === "unknown") && !acknowledgePossibleDuplicate) {
      throw new PolicyError("Confirm possible duplicate before retrying", 409, "TELEGRAM_DUPLICATE_ACK_REQUIRED");
    }
    for (const row of rows) {
      if (row.state === "unknown" || (row.state === "failed" && row.errorCode !== "SUPPRESSED_BY_REVERSAL")) {
        await trx.updateTable("telegramDeliveryParts")
          .set({ state: "pending", errorCode: null, sentAt: null, startedAt: null, updatedAt: new Date() })
          .where("id", "=", row.id)
          .execute();
      }
    }
    await setDeliveryState(trx, delivery.id);
  });
  return dispatchInternal(normalizedId, event, requestOrigin);
}
