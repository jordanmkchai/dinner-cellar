import type { CheckoutReceipt } from "./checkoutPolicy";

type PickupRow = CheckoutReceipt["items"][number];

function assertReceipt(receipt: CheckoutReceipt): void {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Checkout receipt is required");
  if (typeof receipt.id !== "string" || receipt.id.trim().length === 0) throw new Error("Checkout receipt ID is missing");
  if (receipt.status !== "completed" && receipt.status !== "reversed") throw new Error("Checkout receipt status is invalid");
  if (typeof receipt.guestName !== "string" || receipt.guestName.trim().length === 0) throw new Error("Checkout guest name is missing");
  if (!Array.isArray(receipt.items) || receipt.items.length === 0) throw new Error("Checkout has no pickup items");
}

function assertPickupItem(item: PickupRow): void {
  if (
    typeof item.wineId !== "string" || !item.wineId ||
    typeof item.locationId !== "string" || !item.locationId ||
    typeof item.producer !== "string" ||
    typeof item.wineName !== "string" ||
    (item.vintage !== null && typeof item.vintage !== "string") ||
    !Number.isSafeInteger(item.bottleSizeMl) || item.bottleSizeMl < 1 ||
    typeof item.fridge !== "string" || !item.fridge.trim() ||
    typeof item.shelf !== "string" || !item.shelf.trim() ||
    !Number.isSafeInteger(item.quantity) || item.quantity < 1
  ) throw new Error("Checkout has an invalid pickup item");
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function vintageLabel(vintage: string | null): string {
  return vintage?.trim() ? cleanText(vintage.trim()) : "no vintage";
}

function pickupRows(receipt: CheckoutReceipt): PickupRow[] {
  const combined = new Map<string, PickupRow>();
  for (const item of receipt.items) {
    assertPickupItem(item);
    const key = JSON.stringify([
      item.wineId, item.locationId, item.producer, item.wineName, item.vintage,
      item.bottleSizeMl, item.fridge, item.shelf,
    ]);
    const prior = combined.get(key);
    const quantity = (prior?.quantity ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) throw new Error("Checkout pickup quantity exceeds supported limits");
    combined.set(key, { ...item, quantity });
  }
  return [...combined.values()].sort((left, right) =>
    compareStable(left.fridge, right.fridge) ||
    compareStable(left.shelf, right.shelf) ||
    compareStable(left.producer, right.producer) ||
    compareStable(left.wineName, right.wineName) ||
    compareStable(left.vintage ?? "", right.vintage ?? "") ||
    left.bottleSizeMl - right.bottleSizeMl ||
    compareStable(left.wineId, right.wineId) ||
    compareStable(left.locationId, right.locationId),
  );
}

export function formatPickupMessage(receipt: CheckoutReceipt): string {
  assertReceipt(receipt);
  const rows = pickupRows(receipt);
  const total = rows.reduce((sum, item) => sum + item.quantity, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Checkout pickup total exceeds supported limits");

  const lines = [
    "Dinner Cellar pickup",
    `Checkout: ${cleanText(receipt.id.trim())}`,
    `Guest: ${cleanText(receipt.guestName.trim())}`,
    `Status: ${receipt.status === "completed" ? "COMPLETED" : "REVERSED"}`,
  ];
  if (receipt.status === "reversed") lines.push("DO NOT PICK UP");
  lines.push("", "Pickup locations");

  let currentLocation = "";
  for (const item of rows) {
    const location = `${cleanText(item.fridge)} · ${cleanText(item.shelf)}`;
    if (location !== currentLocation) {
      currentLocation = location;
      lines.push("", location);
    }
    const producer = cleanText(item.producer.trim());
    const wineName = cleanText(item.wineName.trim());
    lines.push(`${producer} — ${wineName} (${vintageLabel(item.vintage)}, ${item.bottleSizeMl} mL) × ${item.quantity}`);
  }
  lines.push("", `Total: ${total} ${total === 1 ? "bottle" : "bottles"}`);
  return lines.join("\n");
}

export function formatPickupItemMessage(
  receipt: CheckoutReceipt,
  item: PickupRow,
  ordinal: number,
  itemCount: number,
): string {
  assertReceipt(receipt);
  if (receipt.status !== "completed") throw new Error("Reversed checkout cannot be shared for pickup. DO NOT PICK UP.");
  assertPickupItem(item);
  if (!Number.isInteger(ordinal) || !Number.isInteger(itemCount) || ordinal < 1 || itemCount < ordinal) {
    throw new Error("Pickup item number is invalid");
  }
  const lines = [
    "Dinner Cellar pickup",
    "Checkout: " + cleanText(receipt.id.trim()),
    "Guest: " + cleanText(receipt.guestName.trim()),
    "Status: COMPLETED",
    "Pickup item: " + ordinal + " of " + itemCount,
    "",
    "Take: " + item.quantity + (item.quantity === 1 ? " bottle" : " bottles"),
    cleanText(item.fridge) + " · " + cleanText(item.shelf),
    cleanText(item.producer.trim()) + " — " + cleanText(item.wineName.trim()) +
      " (" + vintageLabel(item.vintage) + ", " + item.bottleSizeMl + " mL) × " + item.quantity,
  ];
  return lines.join("\n");
}

export function wrapPickupText(text: string, measure: (text: string) => number, maxWidth: number): string[] {
  if (typeof text !== "string") throw new Error("Pickup text must be text");
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) throw new Error("Text width is invalid");
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const splitGraphemes = (value: string): string[] => segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : Array.from(value);
  const output: string[] = [];

  for (const sourceLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (sourceLine.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    for (const grapheme of splitGraphemes(sourceLine)) {
      if (line.length > 0 && measure(line + grapheme) > maxWidth) {
          const breakAt = line.lastIndexOf(" ") + 1;
          if (breakAt > 0) {
            output.push(line.slice(0, breakAt));
            line = line.slice(breakAt);
          } else {
            output.push(line);
            line = "";
          }
      }
      line += grapheme;
    }
    output.push(line);
  }
  return output;
}

export function safePickupPhotoUrl(photoPath: string, origin: string): string {
  if (typeof photoPath !== "string" || !photoPath.startsWith("/") || photoPath.startsWith("//") || photoPath.includes("\\")) {
    throw new Error("Photo path is not an allowed cellar asset path");
  }
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(photoPath, base);
  } catch {
    throw new Error("Photo path is invalid");
  }
  const rawPath = photoPath.split(/[?#]/, 1)[0];
  const pathSegments = rawPath.split("/").slice(1);
  const decodedSegments = pathSegments.map((segment) => {
    try { return decodeURIComponent(segment); } catch { return ""; }
  });
  if (
    url.origin !== base.origin ||
    url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !/^\/_cdn\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(rawPath) ||
    decodedSegments.some((segment) => segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
  ) throw new Error("Photo path must point to a same-origin cellar asset");
  return url.href;
}
