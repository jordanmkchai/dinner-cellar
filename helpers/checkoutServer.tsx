import { createHash } from "crypto";
import { sql } from "kysely";
import { db } from "./db";
import { enqueueTelegram } from "./telegramServer";
import {
  addReversalQuantity,
  allocateCheckout,
  normalizeCheckoutDraft,
  resolveCheckoutRecipients,
  type CheckoutDraft,
  type CheckoutPreview,
  type CheckoutReceipt,
  type CheckoutRecipient,
  type CheckoutStockRow,
  type PickupItem,
} from "./checkoutPolicy";
import {
  canonicalJson,
  normalizePhone,
  PolicyError,
} from "./inventoryPolicy";
import {
  type InventoryPrincipal,
  type InventoryTransaction,
  withInventoryOperation,
} from "./inventoryServer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const MAX_ROW_QUANTITY = 2_147_483_647;
const CONTACT_LOCK = "host-contact-designation";

type CheckoutActor = InventoryPrincipal;
type CheckoutReader = Pick<typeof db, "selectFrom">;
type CheckoutItemRow = {
  wineId: string;
  locationId: string;
  quantity: number;
  wineSnapshot: unknown;
  locationSnapshot: unknown;
};
type RecipientSnapshot = CheckoutRecipient & { phoneE164: string };
type CheckoutState = {
  allocation: { items: PickupItem[]; bottleCount: number };
  photoPaths: Record<string, string | null>;
  recipients: CheckoutRecipient[];
  recipientSnapshots: RecipientSnapshot[];
  previewHash: string;
};

function actorKey(principal: CheckoutActor): string {
  return principal.role === "host" ? `host:${principal.userId}` : `guest:${principal.guestLinkId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidDraft(value: unknown): CheckoutDraft {
  try {
    return normalizeCheckoutDraft(value);
  } catch {
    throw new PolicyError("Checkout details are invalid", 400, "INVALID_CHECKOUT");
  }
}

function assertAvailable(allocation: ReturnType<typeof allocateCheckout>): void {
  const missing = allocation.issues.find((issue) => issue.reason === "missing_wine");
  if (missing) throw new PolicyError("A selected wine is no longer available", 409, "WINE_UNAVAILABLE");
  if (allocation.issues.length) {
    throw new PolicyError("Current stock cannot fulfill this checkout", 409, "STOCK_UNAVAILABLE");
  }
}

function assertRecipients(issue: "host_unavailable" | "recipient_unavailable" | null): void {
  if (issue === "host_unavailable") {
    throw new PolicyError("An active host contact is required", 409, "HOST_RECIPIENT_UNAVAILABLE");
  }
  if (issue) throw new PolicyError("A selected recipient is no longer active", 409, "RECIPIENT_UNAVAILABLE");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadCheckoutState(
  reader: CheckoutReader,
  principal: CheckoutActor,
  draft: CheckoutDraft,
  lockContacts = false,
): Promise<CheckoutState> {
  const wineIds = draft.lines.map((line) => line.wineId);
  const rawStockRows = await reader
    .selectFrom("wines")
    .leftJoin("wineStock", "wineStock.wineId", "wines.id")
    .leftJoin("locations", "locations.id", "wineStock.locationId")
    .select([
      "wines.id as wineId",
      "wines.producer as producer",
      "wines.wineName as wineName",
      "wines.vintage as vintage",
      "wines.bottleSizeMl as bottleSizeMl",
      "wines.photoPath as photoPath",
      "locations.id as locationId",
      "locations.fridge as fridge",
      "locations.shelf as shelf",
      "wineStock.quantity as quantity",
      "wineStock.version as version",
    ])
    .where("wines.id", "in", wineIds)
    .orderBy("wines.id")
    .orderBy("locations.fridge")
    .orderBy("locations.shelf")
    .orderBy("locations.id")
    .execute();
  const stockRows: CheckoutStockRow[] = rawStockRows.map((row) => ({
    wineId: row.wineId,
    locationId: row.locationId,
    producer: row.producer,
    wineName: row.wineName,
    vintage: row.vintage,
    bottleSizeMl: row.bottleSizeMl,
    fridge: row.fridge,
    shelf: row.shelf,
    quantity: row.quantity,
    version: row.version === null ? null : String(row.version),
  }));
  const photoPathByWine = new Map<string, string | null>();
  for (const row of rawStockRows) {
    if (!photoPathByWine.has(row.wineId)) photoPathByWine.set(row.wineId, row.photoPath);
  }
  const photoPaths = Object.fromEntries(
    [...new Set(wineIds)].sort(compareText).map((wineId) => [wineId, photoPathByWine.get(wineId) ?? null]),
  );
  stockRows.sort((left, right) =>
    compareText(left.wineId, right.wineId) ||
    compareText(left.fridge ?? "", right.fridge ?? "") ||
    compareText(left.shelf ?? "", right.shelf ?? "") ||
    compareText(left.locationId ?? "", right.locationId ?? ""),
  );

  const allocation = allocateCheckout(draft, stockRows);
  assertAvailable(allocation);

  const contactsQuery = reader
    .selectFrom("contacts")
    .select(["id", "displayName", "phoneE164", "isHost"])
    .where("active", "=", true)
    .orderBy("id");
  const activeContacts = await (lockContacts ? contactsQuery.forShare() : contactsQuery).execute();
  const resolved = resolveCheckoutRecipients(draft, activeContacts.map((contact) => ({
    id: contact.id,
    displayName: contact.displayName,
    isHost: contact.isHost,
  })));
  assertRecipients(resolved.issue);

  const contactsById = new Map(activeContacts.map((contact) => [contact.id.toLowerCase(), contact]));
  const recipientSnapshots = resolved.recipients.map((recipient): RecipientSnapshot => {
    const contact = contactsById.get(recipient.id.toLowerCase());
    if (!contact) throw new PolicyError("A selected recipient is no longer active", 409, "RECIPIENT_UNAVAILABLE");
    let phoneE164: string;
    try {
      phoneE164 = normalizePhone(contact.phoneE164);
    } catch {
      throw new PolicyError("A saved recipient contact is invalid", 409, "RECIPIENT_UNAVAILABLE");
    }
    return { id: recipient.id, displayName: recipient.displayName, isHost: recipient.isHost, phoneE164 };
  });
  const previewHash = sha256(canonicalJson({
    actorKey: actorKey(principal),
    draft,
    items: allocation.items,
    bottleCount: allocation.bottleCount,
    photoPaths,
    stockRows,
    recipients: recipientSnapshots,
  }));
  return {
    allocation: { items: allocation.items, bottleCount: allocation.bottleCount },
    photoPaths,
    recipients: resolved.recipients,
    recipientSnapshots,
    previewHash,
  };
}

export async function createCheckoutPreview(principal: CheckoutActor, value: unknown): Promise<CheckoutPreview> {
  const draft = invalidDraft(value);
  const state = await loadCheckoutState(db, principal, draft);
  return {
    previewHash: state.previewHash,
    guestName: draft.guestName,
    items: state.allocation.items,
    recipients: state.recipients,
    bottleCount: state.allocation.bottleCount,
  };
}

async function lockCheckoutWines(trx: InventoryTransaction, wineIds: readonly string[]): Promise<void> {
  for (const wineId of [...new Set(wineIds)].sort(compareText)) {
    const row = await trx.selectFrom("wines").select("id").where("id", "=", wineId).forUpdate().executeTakeFirst();
    if (!row) throw new PolicyError("A selected wine is no longer available", 409, "WINE_UNAVAILABLE");
  }
}

async function lockCheckoutStock(trx: InventoryTransaction, wineIds: readonly string[]): Promise<void> {
  if (!wineIds.length) return;
  await trx
    .selectFrom("wineStock")
    .select(["wineId", "locationId"])
    .where("wineId", "in", [...new Set(wineIds)].sort(compareText))
    .orderBy("wineId")
    .orderBy("locationId")
    .forUpdate()
    .execute();
}

export async function commitCheckout(input: {
  principal: CheckoutActor;
  operationId: string;
  draft: unknown;
  previewHash: string;
}): Promise<CheckoutReceipt> {
  const draft = invalidDraft(input.draft);
  if (!/^[a-f0-9]{64}$/i.test(input.previewHash)) {
    throw new PolicyError("Checkout preview is invalid", 400, "INVALID_PREVIEW");
  }
  const payload = { draft, previewHash: input.previewHash.toLowerCase() };
  const claimed = await withInventoryOperation(
    input.principal,
    input.operationId,
    "checkout",
    payload,
    async (trx) => {
      const wineIds = draft.lines.map((line) => line.wineId).sort(compareText);
      await lockCheckoutWines(trx, wineIds);
      await lockCheckoutStock(trx, wineIds);
      // Contact saves take this advisory lock before locking contact rows.
      await sql`select pg_advisory_xact_lock(hashtextextended(${CONTACT_LOCK}, 0))`.execute(trx);
      const state = await loadCheckoutState(trx, input.principal, draft, true);
      if (state.previewHash !== payload.previewHash) {
        throw new PolicyError("Cellar or recipients changed after review", 409, "PREVIEW_CHANGED");
      }

      const requestHash = sha256(canonicalJson({ kind: "checkout", payload }));
      const checkout = await trx
        .insertInto("checkouts")
        .values({
          actorKey: actorKey(input.principal),
          guestName: draft.guestName,
          dinnerLabel: null,
          status: "completed",
          idempotencyKey: `${actorKey(input.principal)}:${input.operationId.toLowerCase()}`,
          requestHash,
          recipientsSnapshot: state.recipientSnapshots,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const itemValues = state.allocation.items.map((item) => ({
        checkoutId: checkout.id,
        wineId: item.wineId,
        locationId: item.locationId,
        quantity: item.quantity,
        wineSnapshot: {
          producer: item.producer,
          wineName: item.wineName,
          vintage: item.vintage,
          bottleSizeMl: item.bottleSizeMl,
          photoPath: state.photoPaths[item.wineId] ?? null,
        },
        locationSnapshot: { fridge: item.fridge, shelf: item.shelf },
      }));
      await trx.insertInto("checkoutItems").values(itemValues).execute();

      for (const item of state.allocation.items) {
        const updated = await trx
          .updateTable("wineStock")
          .set({
            quantity: sql`quantity - ${item.quantity}`,
            version: sql`version + 1`,
            updatedAt: new Date(),
          })
          .where("wineId", "=", item.wineId)
          .where("locationId", "=", item.locationId)
          .where("quantity", ">=", item.quantity)
          .returning("quantity")
          .executeTakeFirst();
        if (!updated) throw new PolicyError("Current stock cannot fulfill this checkout", 409, "STOCK_UNAVAILABLE");
        await trx.insertInto("stockMovements").values({
          wineId: item.wineId,
          locationId: item.locationId,
          quantityDelta: -item.quantity,
          kind: "checkout",
          actorName: draft.guestName,
          note: "Cart checkout",
          checkoutId: checkout.id,
        }).execute();
      }
      await enqueueTelegram(trx, {
        checkoutId: checkout.id, event: "checkout", guestName: draft.guestName,
        recipientNames: state.recipients.map((recipient) => recipient.displayName),
        items: state.allocation.items.map((item) => ({
          ...item, photoPath: state.photoPaths[item.wineId] ?? null,
        })),
      });
      return { checkoutId: checkout.id };
    },
  );
  return getCheckoutReceipt(input.principal, claimed.checkoutId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Invalid receipt ${field}`);
  return value.toLowerCase();
}

function requireText(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`Invalid receipt ${field}`);
  return value;
}

function parseRecipients(value: unknown): CheckoutRecipient[] {
  if (!Array.isArray(value) || value.length > 101) throw new Error("Invalid receipt recipients");
  const ids = new Set<string>();
  const recipients = value.map((entry): CheckoutRecipient => {
    if (!isRecord(entry)) throw new Error("Invalid receipt recipient");
    const id = requireUuid(entry.id, "recipient ID");
    const displayName = requireText(entry.displayName, "recipient name", 160);
    if (typeof entry.isHost !== "boolean") throw new Error("Invalid receipt recipient role");
    if (Object.keys(entry).some((key) => !["id", "displayName", "isHost", "phoneE164"].includes(key))) {
      throw new Error("Invalid receipt recipient snapshot");
    }
    if (entry.phoneE164 !== undefined && (typeof entry.phoneE164 !== "string" || !PHONE.test(entry.phoneE164))) {
      throw new Error("Invalid receipt recipient phone");
    }
    if (ids.has(id)) throw new Error("Duplicate receipt recipient");
    ids.add(id);
    return { id, displayName, isHost: entry.isHost };
  });
  if (recipients.filter((recipient) => recipient.isHost).length > 1) throw new Error("Invalid receipt host recipients");
  return recipients;
}

function parsePickupItem(row: CheckoutItemRow): PickupItem {
  if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_ROW_QUANTITY) {
    throw new Error("Invalid receipt quantity");
  }
  requireUuid(row.wineId, "wine ID");
  requireUuid(row.locationId, "location ID");
  if (!isRecord(row.wineSnapshot) || !isRecord(row.locationSnapshot)) throw new Error("Invalid receipt snapshot");
  const wine = row.wineSnapshot;
  const location = row.locationSnapshot;
  const producer = requireText(wine.producer, "producer");
  const wineName = requireText(wine.wineName, "wine name");
  const vintage = wine.vintage;
  if (vintage !== null && typeof vintage !== "string") throw new Error("Invalid receipt vintage");
  const bottleSizeMl = wine.bottleSizeMl;
  if (!Number.isSafeInteger(bottleSizeMl) || Number(bottleSizeMl) < 1) throw new Error("Invalid receipt bottle size");
  const fridge = requireText(location.fridge, "fridge");
  const shelf = requireText(location.shelf, "shelf");
  return {
    wineId: row.wineId.toLowerCase(),
    locationId: row.locationId.toLowerCase(),
    producer,
    wineName,
    vintage: vintage as string | null,
    bottleSizeMl: Number(bottleSizeMl),
    fridge,
    shelf,
    quantity: row.quantity,
  };
}

function isoTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid receipt ${field}`);
  return date.toISOString();
}

function buildReceipt(row: {
  id: string;
  status: string;
  guestName: string;
  createdAt: Date | string;
  reversedAt: Date | string | null;
  recipientsSnapshot: unknown;
}, itemRows: readonly CheckoutItemRow[]): CheckoutReceipt {
  if (row.status !== "completed" && row.status !== "reversed") throw new Error("Invalid receipt status");
  const guestName = requireText(row.guestName, "guest name", 500);
  const createdAt = isoTimestamp(row.createdAt, "created time");
  const reversedAt = row.reversedAt === null ? null : isoTimestamp(row.reversedAt, "reversal time");
  if ((row.status === "reversed") !== (reversedAt !== null)) throw new Error("Invalid receipt reversal state");
  const items = itemRows.map(parsePickupItem);
  const recipients = parseRecipients(row.recipientsSnapshot);
  const bottleCount = items.reduce((total, item) => total + item.quantity, 0);
  if (!Number.isSafeInteger(bottleCount)) throw new Error("Invalid receipt item total");
  return {
    id: requireUuid(row.id, "checkout ID"),
    status: row.status,
    guestName,
    createdAt,
    reversedAt,
    items,
    recipients,
    bottleCount,
  };
}

async function fetchCheckoutRows(ids: readonly string[]): Promise<Map<string, CheckoutItemRow[]>> {
  if (!ids.length) return new Map();
  const rows = await db
    .selectFrom("checkoutItems")
    .select(["checkoutId", "wineId", "locationId", "quantity", "wineSnapshot", "locationSnapshot"])
    .where("checkoutId", "in", ids)
    .orderBy("checkoutId")
    .orderBy("wineId")
    .orderBy("locationId")
    .execute();
  const grouped = new Map<string, CheckoutItemRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.checkoutId) ?? [];
    group.push(row);
    grouped.set(row.checkoutId, group);
  }
  return grouped;
}

export async function getCheckoutReceipt(principal: CheckoutActor, checkoutId: string): Promise<CheckoutReceipt> {
  if (!UUID.test(checkoutId)) throw new PolicyError("Checkout not found", 404, "CHECKOUT_NOT_FOUND");
  const row = await db
    .selectFrom("checkouts")
    .select(["id", "actorKey", "status", "guestName", "createdAt", "reversedAt", "recipientsSnapshot"])
    .where("id", "=", checkoutId.toLowerCase())
    .executeTakeFirst();
  if (!row) throw new PolicyError("Checkout not found", 404, "CHECKOUT_NOT_FOUND");
  if (principal.role === "guest" && row.actorKey !== actorKey(principal)) {
    throw new PolicyError("Checkout not found", 404, "CHECKOUT_NOT_FOUND");
  }
  const items = await fetchCheckoutRows([row.id]);
  return buildReceipt(row, items.get(row.id) ?? []);
}

export async function getHostCheckouts(): Promise<{ checkouts: CheckoutReceipt[]; limit: 100 }> {
  const rows = await db
    .selectFrom("checkouts")
    .select(["id", "status", "guestName", "createdAt", "reversedAt", "recipientsSnapshot"])
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(100)
    .execute();
  const items = await fetchCheckoutRows(rows.map((row) => row.id));
  return {
    checkouts: rows.map((row) => buildReceipt(row, items.get(row.id) ?? [])),
    limit: 100,
  };
}

export async function reverseCheckout(input: {
  principal: Extract<CheckoutActor, { role: "host" }>;
  operationId: string;
  checkoutId: string;
}): Promise<CheckoutReceipt> {
  if (!UUID.test(input.checkoutId)) throw new PolicyError("Checkout not found", 404, "CHECKOUT_NOT_FOUND");
  const checkoutId = input.checkoutId.toLowerCase();
  const result = await withInventoryOperation(
    input.principal,
    input.operationId,
    "checkout.reverse",
    { checkoutId },
    async (trx) => {
      const checkout = await trx
        .selectFrom("checkouts")
        .select(["id", "status", "guestName", "recipientsSnapshot"])
        .where("id", "=", checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout) throw new PolicyError("Checkout not found", 404, "CHECKOUT_NOT_FOUND");
      if (checkout.status === "reversed") return { checkoutId: checkout.id };
      if (checkout.status !== "completed") throw new PolicyError("Checkout cannot be reversed", 409, "CHECKOUT_STATE_INVALID");

      const items = await trx
        .selectFrom("checkoutItems")
        .select(["wineId", "locationId", "quantity", "wineSnapshot", "locationSnapshot"])
        .where("checkoutId", "=", checkout.id)
        .orderBy("wineId")
        .orderBy("locationId")
        .execute();
      if (!items.length) throw new PolicyError("Checkout has no restorable items", 409, "CHECKOUT_ITEMS_INVALID");
      const wineIds = [...new Set(items.map((item) => item.wineId))].sort(compareText);
      await lockCheckoutWines(trx, wineIds);
      await lockCheckoutStock(trx, wineIds);
      const stockRows = await trx
        .selectFrom("wineStock")
        .select(["wineId", "locationId", "quantity"])
        .where("wineId", "in", wineIds)
        .orderBy("wineId")
        .orderBy("locationId")
        .execute();
      const stockByKey = new Map(stockRows.map((stock) => [`${stock.wineId}:${stock.locationId}`, stock]));

      for (const item of items) {
        const key = `${item.wineId}:${item.locationId}`;
        const current = stockByKey.get(key);
        let nextQuantity: number;
        try {
          nextQuantity = addReversalQuantity(current?.quantity ?? 0, item.quantity);
        } catch {
          throw new PolicyError("Restored stock would exceed the supported quantity", 409, "STOCK_LIMIT_EXCEEDED");
        }
        if (current) {
          await trx
            .updateTable("wineStock")
            .set({ quantity: nextQuantity, version: sql`version + 1`, updatedAt: new Date() })
            .where("wineId", "=", item.wineId)
            .where("locationId", "=", item.locationId)
            .execute();
        } else {
          await trx.insertInto("wineStock").values({
            wineId: item.wineId,
            locationId: item.locationId,
            quantity: nextQuantity,
            version: sql`1`,
            updatedAt: new Date(),
          }).execute();
        }
        await trx.insertInto("stockMovements").values({
          wineId: item.wineId,
          locationId: item.locationId,
          quantityDelta: item.quantity,
          kind: "reversal",
          actorName: "Host",
          note: "Checkout reversed",
          checkoutId: checkout.id,
        }).execute();
      }

      const now = new Date();
      await trx.updateTable("checkouts").set({
        status: "reversed",
        reversedAt: now,
        reversedBy: actorKey(input.principal),
      }).where("id", "=", checkout.id).execute();
      await enqueueTelegram(trx, {
        checkoutId: checkout.id, event: "reversal", guestName: checkout.guestName,
        recipientNames: parseRecipients(checkout.recipientsSnapshot).map((recipient) => recipient.displayName),
        items: items.map((row) => ({
          ...parsePickupItem(row),
          photoPath: isRecord(row.wineSnapshot) && typeof row.wineSnapshot.photoPath === "string"
            ? row.wineSnapshot.photoPath : null,
        })),
      });
      return { checkoutId: checkout.id };
    },
  );
  return getCheckoutReceipt(input.principal, result.checkoutId);
}
