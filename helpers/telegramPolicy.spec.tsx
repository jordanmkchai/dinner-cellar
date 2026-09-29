import {
  classifyTelegramResponse,
  createTelegramParts,
  formatTelegramMessage,
  isSafeTelegramPhotoPath,
  parseTelegramUpdates,
  splitTelegramText,
  sendTelegramOutcome,
  telegramPhotoUrl,
  type TelegramEnqueueInput,
} from "./telegramPolicy";

const notification: TelegramEnqueueInput = {
  checkoutId: "01234567-89ab-4cde-8fab-0123456789ab",
  event: "checkout",
  guestName: "Ari Guest",
  recipientNames: ["Host", "Mina"],
  items: [{
    producer: "Domaine Test",
    wineName: "Unicode Cuvée 🍷",
    vintage: "2020",
    bottleSizeMl: 750,
    fridge: "Main cellar",
    shelf: "A-2",
    quantity: 3,
    photoPath: "/_cdn/static/wine-1.png",
  }],
};

describe("Telegram notification policy", () => {
  it("formats complete host-only pickup text and clear reversal warning without phone data", () => {
    const text = formatTelegramMessage(notification);
    expect(text).toContain(notification.checkoutId);
    expect(text).toContain("Guest: Ari Guest");
    expect(text).toContain("Recipients: Host, Mina");
    expect(text).toContain("Domaine Test — Unicode Cuvée 🍷 (2020), 750 ml");
    expect(text).toContain("Bottle count: 3");
    expect(text).toContain("Fridge: Main cellar");
    expect(text).toContain("Shelf: A-2");
    expect(formatTelegramMessage({ ...notification, items: [{ ...notification.items[0], vintage: null }] }))
      .toContain("Vintage not recorded");
    expect(text).not.toMatch(/\+\d{8,}/);
    expect(formatTelegramMessage({ ...notification, event: "reversal" }))
      .toContain("CHECKOUT REVERSED — DO NOT PICK UP");
  });

  it("splits long Unicode text without clipping, reordering, or breaking surrogate pairs", () => {
    const source = ("pickup 🍷 line\n").repeat(1300);
    const chunks = splitTelegramText(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
    expect(chunks.join("")).toBe(source);
    expect(chunks.some((chunk) => chunk.endsWith("\ud83c") || chunk.startsWith("\udf77"))).toBe(false);
  });

  it("accepts only same-origin public CDN paths for photo sends", () => {
    expect(isSafeTelegramPhotoPath("/_cdn/static/wine-1.png")).toBe(true);
    expect(telegramPhotoUrl("/_cdn/static/wine-1.png", "https://cellar.example"))
      .toBe("https://cellar.example/_cdn/static/wine-1.png");
    for (const path of [
      "https://attacker.example/photo.png",
      "//attacker.example/photo.png",
      "/_api/private/photo",
      "/_cdn/static/../private.png",
      "/_cdn/static/photo.png?next=https://attacker.example",
    ]) expect(isSafeTelegramPhotoPath(path)).toBe(false);
    expect(() => telegramPhotoUrl("/_cdn/static/wine-1.png", "http://cellar.example")).toThrow();
  });

  it("parses getUpdates result arrays and rejects malformed response shapes", () => {
    const updates = [{ update_id: 1, message: { text: "/start nonce" } }];
    expect(parseTelegramUpdates({ ok: true, result: updates })).toEqual(updates);
    expect(parseTelegramUpdates({ ok: true, result: { updates } })).toBeNull();
    expect(parseTelegramUpdates({ ok: false, result: updates })).toBeNull();
  });

  it("keeps full text chunks and adds photo captions only for validated paths", () => {
    const parts = createTelegramParts({
      ...notification,
      items: [
        notification.items[0],
        { ...notification.items[0], wineName: "No photo", photoPath: "https://attacker.example/photo.png" },
      ],
    });
    const textParts = parts.filter((part) => part.kind === "text");
    const photoParts = parts.filter((part) => part.kind === "photo");
    expect(textParts.map((part) => part.content).join("")).toBe(formatTelegramMessage({
      ...notification,
      items: [
        notification.items[0],
        { ...notification.items[0], wineName: "No photo", photoPath: "https://attacker.example/photo.png" },
      ],
    }));
    expect(photoParts.length).toBe(1);
    expect(photoParts[0].content.length).toBeLessThanOrEqual(1024);
    expect(photoParts[0].content).toContain("Bottle count: 3");
    expect(photoParts[0].content).toContain("Fridge: Main cellar");
    expect(photoParts[0].content).toContain("Shelf: A-2");
    expect(photoParts[0].photoPath).toBe("/_cdn/static/wine-1.png");
    const reversalParts = createTelegramParts({ ...notification, event: "reversal" });
    expect(reversalParts.every((part) => part.kind === "text")).toBe(true);
  });

  it("supports more than 100 allocation rows without truncating the receipt", () => {
    const items = Array.from({ length: 140 }, (_, index) => ({
      ...notification.items[0], wineName: `Wine ${index}`, photoPath: null,
    }));
    const text = formatTelegramMessage({ ...notification, items });
    expect(text).toContain("140. Domaine Test — Wine 139");
    expect(splitTelegramText(text).join("")).toBe(text);
  });

  it("distinguishes confirmed success/rejection from uncertain Telegram outcomes", () => {
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 200, body: { ok: true, result: { message_id: 1 } } }))
      .toEqual({ state: "sent", errorCode: null });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 429, body: { ok: false } }))
      .toEqual({ state: "failed", errorCode: "TELEGRAM_RATE_LIMITED" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 401, body: { ok: false } }))
      .toEqual({ state: "failed", errorCode: "TELEGRAM_CREDENTIALS_REJECTED" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 400, body: { ok: false } }))
      .toEqual({ state: "failed", errorCode: "TELEGRAM_REJECTED" });
    expect(classifyTelegramResponse({ kind: "network_error" }))
      .toEqual({ state: "unknown", errorCode: "TELEGRAM_NETWORK_UNCERTAIN" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 200, body: "not JSON" }))
      .toEqual({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 502, body: null }))
      .toEqual({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 502, body: { ok: false } }))
      .toEqual({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" });
    expect(classifyTelegramResponse({ kind: "response", httpStatus: 200, body: { ok: true, result: {} } }))
      .toEqual({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" });
  });

  it("classifies injected transport outcomes without exposing raw fetch errors", async () => {
    const fetcher = jasmine.createSpy("telegramFetch").and.callFake(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 12 } }), { status: 200 }));
    await expectAsync(sendTelegramOutcome(fetcher, "12345:fake-secret", "sendMessage", { text: "hello" }, 1000))
      .toBeResolvedTo({ state: "sent", errorCode: null });
    expect(fetcher).toHaveBeenCalled();

    fetcher.and.returnValue(Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 429 })));
    await expectAsync(sendTelegramOutcome(fetcher, "12345:fake-secret", "sendMessage", {}, 1000))
      .toBeResolvedTo({ state: "failed", errorCode: "TELEGRAM_RATE_LIMITED" });
    fetcher.and.returnValue(Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 401 })));
    await expectAsync(sendTelegramOutcome(fetcher, "12345:fake-secret", "sendMessage", {}, 1000))
      .toBeResolvedTo({ state: "failed", errorCode: "TELEGRAM_CREDENTIALS_REJECTED" });
    fetcher.and.returnValue(Promise.reject(new Error("token and URL must never escape")));
    await expectAsync(sendTelegramOutcome(fetcher, "12345:fake-secret", "sendMessage", {}, 1000))
      .toBeResolvedTo({ state: "unknown", errorCode: "TELEGRAM_NETWORK_UNCERTAIN" });
    fetcher.and.returnValue(Promise.resolve(new Response("not-json", { status: 200 })));
    await expectAsync(sendTelegramOutcome(fetcher, "12345:fake-secret", "sendMessage", {}, 1000))
      .toBeResolvedTo({ state: "unknown", errorCode: "TELEGRAM_RESPONSE_UNCERTAIN" });

    const timeoutFetch = jasmine.createSpy("telegramTimeoutFetch").and.callFake((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("network error with secret")), { once: true });
      }));
    await expectAsync(sendTelegramOutcome(timeoutFetch, "12345:fake-secret", "sendMessage", {}, 1))
      .toBeResolvedTo({ state: "unknown", errorCode: "TELEGRAM_NETWORK_UNCERTAIN" });
  });
});
