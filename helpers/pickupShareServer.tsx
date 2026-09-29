import { db } from "./db";
import { getCheckoutReceipt } from "./checkoutServer";
import { PolicyError } from "./inventoryPolicy";
import type { CheckoutReceipt, PickupItem } from "./checkoutPolicy";
import type { InventoryPrincipal } from "./inventoryServer";

export type CheckoutSharePhoto = {
  wineId: string;
  locationId: string;
  photoPath: string | null;
};

export type CheckoutSharePacket = {
  receipt: CheckoutReceipt;
  photos: CheckoutSharePhoto[];
  preparedAt: string;
};

type CheckoutSnapshotRow = {
  wineId: string;
  locationId: string;
  wineSnapshot: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeReceipt(receipt: CheckoutReceipt): CheckoutReceipt {
  const items: PickupItem[] = receipt.items.map((item) => ({
    wineId: item.wineId,
    locationId: item.locationId,
    producer: item.producer,
    wineName: item.wineName,
    vintage: item.vintage,
    bottleSizeMl: item.bottleSizeMl,
    fridge: item.fridge,
    shelf: item.shelf,
    quantity: item.quantity,
  }));
  return {
    id: receipt.id,
    status: receipt.status,
    guestName: receipt.guestName,
    createdAt: receipt.createdAt,
    reversedAt: receipt.reversedAt,
    items,
    recipients: receipt.recipients.map(({ id, displayName, isHost }) => ({ id, displayName, isHost })),
    bottleCount: receipt.bottleCount,
  };
}

export function photoPathFromSnapshot(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) throw new Error("Invalid checkout wine snapshot");
  const photoPath = snapshot.photoPath;
  if (photoPath === undefined || photoPath === null || photoPath === "") return null;
  if (typeof photoPath !== "string" || photoPath.length > 4096 || !photoPath.trim()) {
    throw new Error("Invalid checkout photo snapshot");
  }
  return photoPath;
}

export async function getCheckoutSharePacket(
  principal: Extract<InventoryPrincipal, { role: "host" }>,
  checkoutId: string,
): Promise<CheckoutSharePacket> {
  const receipt = await getCheckoutReceipt(principal, checkoutId);
  if (receipt.status === "reversed") {
    throw new PolicyError("Reversed checkout cannot be shared", 409, "CHECKOUT_REVERSED");
  }

  const rows: CheckoutSnapshotRow[] = await db
    .selectFrom("checkoutItems")
    .select(["wineId", "locationId", "wineSnapshot"])
    .where("checkoutId", "=", receipt.id)
    .orderBy("wineId")
    .orderBy("locationId")
    .execute();
  const snapshotsByItem = new Map(rows.map((row) => [
    `${row.wineId.toLowerCase()}:${row.locationId.toLowerCase()}`,
    row.wineSnapshot,
  ]));

  const photos = receipt.items.map(({ wineId, locationId }) => {
    const key = `${wineId.toLowerCase()}:${locationId.toLowerCase()}`;
    if (!snapshotsByItem.has(key)) throw new Error("Checkout photo snapshots are incomplete");
    return {
      wineId,
      locationId,
      photoPath: photoPathFromSnapshot(snapshotsByItem.get(key)),
    };
  });

  return { receipt: sanitizeReceipt(receipt), photos, preparedAt: new Date().toISOString() };
}
