export type TelegramEvent = "checkout" | "reversal";

export type TelegramPickupItem = {
  producer: string;
  wineName: string;
  vintage: string | null;
  bottleSizeMl: number;
  fridge: string;
  shelf: string;
  quantity: number;
  photoPath: string | null;
};

export type TelegramEnqueueInput = {
  checkoutId: string;
  event: TelegramEvent;
  guestName: string;
  recipientNames: string[];
  items: TelegramPickupItem[];
};

export type TelegramMessagePart =
  | { kind: "text"; content: string; photoPath: null }
  | { kind: "photo"; content: string; photoPath: string };

export type TelegramPartOutcome =
  | { state: "sent"; errorCode: null }
  | { state: "failed"; errorCode: "TELEGRAM_CREDENTIALS_REJECTED" | "TELEGRAM_RATE_LIMITED" | "TELEGRAM_REJECTED" | "TELEGRAM_PHOTO_PATH_UNSAFE" }
  | { state: "unknown"; errorCode: "TELEGRAM_NETWORK_UNCERTAIN" | "TELEGRAM_RESPONSE_UNCERTAIN" };

const CDN_PATH = /^\/_cdn\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredText(value: string, field: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid Telegram notification ${field}`);
  }
  return value.trim();
}

function captionText(value: string, maxLength: number): string {
  const result: string[] = [];
  let length = 0;
  for (const character of value.trim()) {
    if (length + character.length > maxLength - 1) return result.join("") + "…";
    result.push(character);
    length += character.length;
  }
  return result.join("");
}

export function isSafeTelegramPhotoPath(value: unknown): value is string {
  return typeof value === "string" && CDN_PATH.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
}

export function parseTelegramUpdates(value: unknown): unknown[] | null {
  const response = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  return response?.ok === true && Array.isArray(response.result) ? response.result : null;
}

export function telegramPhotoUrl(photoPath: string, requestOrigin: string): string {
  if (!isSafeTelegramPhotoPath(photoPath)) throw new Error("Unsafe Telegram photo path");
  let base: URL;
  let photo: URL;
  try {
    base = new URL(requestOrigin);
    photo = new URL(photoPath, base);
  } catch {
    throw new Error("Invalid Telegram request origin");
  }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash ||
      base.username || base.password || photo.origin !== base.origin || photo.search || photo.hash ||
      photo.username || photo.password) {
    throw new Error("Invalid Telegram photo URL");
  }
  return photo.href;
}

export function splitTelegramText(value: string, maxLength = 3900): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 3900) {
    throw new Error("Invalid Telegram message limit");
  }
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length + character.length > maxLength) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

export function formatTelegramMessage(input: TelegramEnqueueInput): string {
  if (!UUID.test(input.checkoutId)) throw new Error("Invalid Telegram checkout ID");
  if (input.event !== "checkout" && input.event !== "reversal") throw new Error("Invalid Telegram event");
  const guestName = requiredText(input.guestName, "guest name");
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new Error("Invalid Telegram item list");
  }
  const recipients = input.recipientNames.map((name) => requiredText(name, "recipient name"));
  const bottleCount = input.items.reduce((total, item) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.bottleSizeMl) || item.bottleSizeMl < 1) {
      throw new Error("Invalid Telegram item quantity");
    }
    return total + item.quantity;
  }, 0);
  if (!Number.isSafeInteger(bottleCount)) throw new Error("Invalid Telegram total quantity");

  const reversed = input.event === "reversal";
  const lines = [
    reversed ? "CHECKOUT REVERSED — DO NOT PICK UP" : "PICKUP CHECKOUT",
    `Checkout ID: ${input.checkoutId}`,
    `Guest: ${guestName}`,
    `Recipients: ${recipients.length ? recipients.join(", ") : "None"}`,
    `Total bottles: ${bottleCount}`,
    "",
  ];
  input.items.forEach((item, index) => {
    const producer = requiredText(item.producer, "producer");
    const wineName = requiredText(item.wineName, "wine name");
    const vintage = item.vintage === null ? "Vintage not recorded" : requiredText(item.vintage, "vintage");
    const fridge = requiredText(item.fridge, "fridge");
    const shelf = requiredText(item.shelf, "shelf");
    lines.push(
      `${index + 1}. ${producer} — ${wineName} (${vintage}), ${item.bottleSizeMl} ml`,
      `   Bottle count: ${item.quantity}`,
      `   Fridge: ${fridge}`,
      `   Shelf: ${shelf}`,
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

export function createTelegramParts(input: TelegramEnqueueInput): TelegramMessagePart[] {
  const fullText = formatTelegramMessage(input);
  const parts: TelegramMessagePart[] = splitTelegramText(fullText).map((content) => ({
    kind: "text",
    content,
    photoPath: null,
  }));
  const photoItems = (input.event === "checkout" ? input.items : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isSafeTelegramPhotoPath(item.photoPath));
  for (const { item, index } of photoItems) {
    const caption = [
      `Checkout ${input.checkoutId} · item ${index + 1}/${input.items.length}`,
      `Producer: ${captionText(requiredText(item.producer, "producer"), 200)}`,
      `Wine: ${captionText(requiredText(item.wineName, "wine name"), 200)}`,
      `Vintage: ${item.vintage === null ? "not recorded" : captionText(requiredText(item.vintage, "vintage"), 64)}`,
      `Bottle count: ${item.quantity}`,
      `Fridge: ${captionText(requiredText(item.fridge, "fridge"), 120)}`,
      `Shelf: ${captionText(requiredText(item.shelf, "shelf"), 120)}`,
    ].join("\n");
    if (caption.length > 1024) throw new Error("Telegram photo caption exceeds limit");
    parts.push({ kind: "photo", content: caption, photoPath: item.photoPath! });
  }
  return parts;
}

export function classifyTelegramResponse(input:
  | { kind: "network_error" }
  | { kind: "response"; httpStatus: number; body: unknown },
): TelegramPartOutcome {
  if (input.kind === "network_error") return { state: "unknown", errorCode: "TELEGRAM_NETWORK_UNCERTAIN" };
  const record = input.body !== null && typeof input.body === "object" && !Array.isArray(input.body)
    ? input.body as Record<string, unknown>
    : null;
  if (input.httpStatus >= 200 && input.httpStatus < 300 && record?.ok === true) {
    const result = record.result !== null && typeof record.result === "object" && !Array.isArray(record.result)
      ? record.result as Record<string, unknown>
      : null;
    if (result && Number.isSafeInteger(result.message_id)) return { state: "sent", errorCode: null };
    return { state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" };
  }
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return { state: "failed", errorCode: "TELEGRAM_CREDENTIALS_REJECTED" };
  }
  if (input.httpStatus === 429) return { state: "failed", errorCode: "TELEGRAM_RATE_LIMITED" };
  if (input.httpStatus >= 500) return { state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" };
  if (record?.ok === false || (input.httpStatus >= 400 && input.httpStatus < 500)) {
    return { state: "failed", errorCode: "TELEGRAM_REJECTED" };
  }
  return { state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" };
}

export async function sendTelegramOutcome(
  fetcher: typeof fetch,
  token: string,
  method: "sendMessage" | "sendPhoto",
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<TelegramPartOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
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
    return classifyTelegramResponse({ kind: "response", httpStatus: response.status, body });
  } catch {
    return classifyTelegramResponse({ kind: "network_error" });
  } finally {
    clearTimeout(timeout);
  }
}
