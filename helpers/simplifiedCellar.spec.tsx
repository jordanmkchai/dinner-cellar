import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import WinesPage from "../pages/wines";
import CartPage from "../pages/cart";
import { AuthProvider, AUTH_QUERY_KEY } from "./useAuth";
import { resetPrivateCart } from "./cartStore";
import type { CartContext } from "./cartPolicy";

const wineId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";
const scope = "cart-v1:" + "f".repeat(64);
const cartKey = "dinner-cellar:cart:v1:" + encodeURIComponent(scope);
const recoveryKey = "dinner-cellar:cart:checkout:v1:" + encodeURIComponent(scope);
const context: CartContext = {
  scope, role: "guest", hostRecipientId: hostId,
  recipients: [{ id: hostId, displayName: "Test host", isHost: true }],
  wines: [{ id: wineId, producer: "Test producer", wineName: "Test wine", vintage: "2020", country: "France", region: null, subregion: null, appellation: null, grapeBlend: null, colour: "Red", wineStyle: null, sweetness: null, bottleSizeMl: 750, photoPath: null, totalQuantity: 3, locations: [{ locationId: hostId, fridge: "F1", shelf: "S1", quantity: 3 }] }],
};
const receipt = { id: receiptId, status: "completed", guestName: "Guest", createdAt: "2026-09-25T00:00:00Z", reversedAt: null, items: [], recipients: context.recipients, bottleCount: 2 };
const preview = { previewHash: "a".repeat(64), guestName: "Guest", items: [], recipients: context.recipients, bottleCount: 2 };
function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => superjson.stringify(data) } as Response;
}
function seedCart() {
  localStorage.setItem(cartKey, JSON.stringify({ version: 1, scope, draft: { lines: [{ wineId, quantity: 2 }], guestName: "Old name", additionalRecipientIds: [receiptId] } }));
}
function show(Page: React.ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(AUTH_QUERY_KEY, null);
  render(<QueryClientProvider client={client}><AuthProvider><MemoryRouter><Page /></MemoryRouter></AuthProvider></QueryClientProvider>);
  return client;
}

describe("Simplified cellar UI", () => {
  const browserEventGlobals = ["Event", "CustomEvent"] as const;
  const originalEvents = browserEventGlobals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  let requests: { path: string; body: any }[];
  let previewFailure: boolean;
  let uncertainCommit: boolean;
  let beforePreviewResponse: (() => void) | undefined;
  beforeEach(() => {
    // Radix dispatches DOM events; the runner's Node event constructors belong to another realm.
    browserEventGlobals.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] }));
    const tails = new Map<string, Promise<unknown>>();
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: (name: string, _options: unknown, callback: () => unknown) => {
        const result = (tails.get(name) ?? Promise.resolve()).then(callback);
        tails.set(name, result.catch(() => undefined));
        return result;
      },
    } });
    resetPrivateCart();
    localStorage.clear();
    requests = [];
    previewFailure = false;
    uncertainCommit = false;
    beforePreviewResponse = undefined;
    spyOn(globalThis, "fetch").and.callFake(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? superjson.parse(String(init.body)) : null;
      requests.push({ path, body });
      if (path === "/_api/cellar/cart-context") return response(context);
      if (path === "/_api/cellar/checkout-preview") {
        beforePreviewResponse?.();
        return previewFailure ? response({ message: "Stock changed", code: "STOCK_UNAVAILABLE" }, 409) : response(preview);
      }
      if (path === "/_api/cellar/checkout" && init?.method === "POST") {
        expect(localStorage.getItem(recoveryKey)).toContain((body as any).operationId);
        if (uncertainCommit) throw new TypeError("Simulated lost response");
        return response(receipt);
      }
      if (path.startsWith("/_api/cellar/checkout?")) return response(receipt);
      throw new Error("Unexpected mocked request: " + path);
    });
  });
  afterEach(() => {
    cleanup(); resetPrivateCart(); localStorage.clear();
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else Reflect.deleteProperty(navigator, "locks");
    browserEventGlobals.forEach((name, index) => {
      const descriptor = originalEvents[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    });
  });

  it("collapses advanced filters and applies bottle selection within remaining stock", async () => {
    show(WinesPage);
    const toggle = await screen.findByRole("button", { name: "Advanced filters" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Fridge")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Fridge")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Fridge")).toBeNull();
    const plus = screen.getAllByRole("button", { name: "Increase quantity of Test wine" })[0];
    const minus = screen.getAllByRole("button", { name: "Decrease quantity of Test wine" })[0];
    await waitFor(() => { if ((plus as HTMLButtonElement).disabled) throw new Error("Quantity still disabled"); });
    fireEvent.click(plus); fireEvent.click(plus);
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(minus);
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    expect(JSON.parse(localStorage.getItem(cartKey)!).draft.lines[0].quantity).toBe(2);
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    expect(JSON.parse(localStorage.getItem(cartKey)!).draft.lines[0].quantity).toBe(3);
    expect((screen.getByRole("button", { name: "Add 0" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms in one action, drops obsolete details, and prevents double checkout", async () => {
    seedCart(); show(CartPage);
    const confirm = await screen.findByRole("button", { name: "Confirm checkout" });
    await waitFor(() => { if ((confirm as HTMLButtonElement).disabled) throw new Error("Checkout still disabled: " + document.body.textContent); });
    expect(screen.queryByText("Request details")).toBeNull();
    expect(screen.queryByText("Pickup plan")).toBeNull();
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => { if (!screen.queryByText("Checkout completed.")) throw new Error(JSON.stringify({ alerts: screen.queryAllByRole("alert").map(x => x.textContent), paths: requests.map(x => x.path) })); });
    const commits = requests.filter(r => r.path === "/_api/cellar/checkout" && r.body);
    expect(commits.length).toBe(1);
    expect(commits[0].body.draft.guestName).toBe("Guest");
    expect(commits[0].body.draft.additionalRecipientIds).toEqual([]);
    const saved = localStorage.getItem(cartKey);
    expect(saved ? JSON.parse(saved).draft.lines : []).toEqual([]);
  });

  it("does not commit when the internal stock preview fails", async () => {
    seedCart(); previewFailure = true; show(CartPage);
    const confirm = await screen.findByRole("button", { name: "Confirm checkout" });
    await waitFor(() => { if ((confirm as HTMLButtonElement).disabled) throw new Error("Checkout still disabled: " + document.body.textContent); });
    fireEvent.click(confirm);
    await screen.findByText(/Stock changed/);
    expect(requests.filter(r => r.path === "/_api/cellar/checkout" && r.body).length).toBe(0);
    expect(localStorage.getItem(recoveryKey) ?? "").not.toContain("operationId");
  });

  it("retries uncertain checkout with exactly the same saved operation", async () => {
    seedCart(); uncertainCommit = true; show(CartPage);
    const confirm = await screen.findByRole("button", { name: "Confirm checkout" });
    await waitFor(() => { if ((confirm as HTMLButtonElement).disabled) throw new Error("Checkout still disabled: " + document.body.textContent); });
    fireEvent.click(confirm);
    await waitFor(() => { if (requests.filter(r => r.path === "/_api/cellar/checkout" && r.body).length !== 1) throw new Error(JSON.stringify({ alerts: screen.queryAllByRole("alert").map(x => x.textContent), paths: requests.map(x => x.path) })); });
    await waitFor(() => { if ((screen.getByRole("button", { name: "Confirm checkout" }) as HTMLButtonElement).disabled) throw new Error("Retry still disabled"); });
    uncertainCommit = false;
    fireEvent.click(screen.getByRole("button", { name: "Confirm checkout" }));
    await waitFor(() => { if (!screen.queryByText("Checkout completed.")) throw new Error(JSON.stringify({ alerts: screen.queryAllByRole("alert").map(x => x.textContent), paths: requests.map(x => x.path) })); });
    const commits = requests.filter(r => r.path === "/_api/cellar/checkout" && r.body);
    expect(commits.length).toBe(2);
    expect(commits[1].body).toEqual(commits[0].body);
    expect(requests.filter(r => r.path === "/_api/cellar/checkout-preview").length).toBe(1);
  });

  it("opens wine details above the page and returns focus to the trigger", async () => {
    show(WinesPage);
    const trigger = (await screen.findAllByRole("button", { name: "View details" }))[0];
    trigger.focus();
    try { fireEvent.click(trigger); } catch (error) {
      const errors = (error as { errors?: unknown[] }).errors;
      throw new Error(errors ? errors.map(e => String(e)).join("; ") : String(error));
    }
    const dialog = await screen.findByRole("dialog", { name: "Test producer · Test wine" });
    expect(document.querySelector("main")?.contains(dialog)).toBe(false);
    await waitFor(() => { if (!dialog.contains(document.activeElement)) throw new Error("Dialog did not receive focus"); });
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => { if (screen.queryByRole("dialog")) throw new Error("Dialog still open"); });
    await waitFor(() => { if (document.activeElement !== trigger) throw new Error("Trigger focus not restored"); });
  });

  it("does not commit if private access changes before the preview response", async () => {
    seedCart();
    const client = show(CartPage);
    beforePreviewResponse = () => client.setQueryData(["cart-context"], { ...context, scope: "cart-v1:" + "e".repeat(64) });
    const confirm = await screen.findByRole("button", { name: "Confirm checkout" });
    await waitFor(() => { if ((confirm as HTMLButtonElement).disabled) throw new Error("Checkout still disabled"); });
    fireEvent.click(confirm);
    await screen.findByText("Cart or private access changed during checkout. Refresh and try again.");
    expect(requests.filter(r => r.path === "/_api/cellar/checkout" && r.body).length).toBe(0);
    expect(localStorage.getItem(recoveryKey) ?? "").not.toContain("operationId");
  });
});
