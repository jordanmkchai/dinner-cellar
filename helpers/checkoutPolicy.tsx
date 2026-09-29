export type CheckoutDraft = {
  lines: { wineId: string; quantity: number }[];
  guestName: string;
  additionalRecipientIds: string[];
};

export type PickupItem = {
  wineId: string;
  locationId: string;
  producer: string;
  wineName: string;
  vintage: string | null;
  bottleSizeMl: number;
  fridge: string;
  shelf: string;
  quantity: number;
};

export type CheckoutRecipient = { id: string; displayName: string; isHost: boolean };

export type CheckoutPreview = {
  previewHash: string;
  guestName: string;
  items: PickupItem[];
  recipients: CheckoutRecipient[];
  bottleCount: number;
};

export type CheckoutReceipt = {
  id: string;
  status: "completed" | "reversed";
  guestName: string;
  createdAt: string;
  reversedAt: string | null;
  items: PickupItem[];
  recipients: CheckoutRecipient[];
  bottleCount: number;
};

export type CheckoutStockRow = {
  wineId: string;
  locationId: string | null;
  producer: string;
  wineName: string;
  vintage: string | null;
  bottleSizeMl: number;
  fridge: string | null;
  shelf: string | null;
  quantity: number | null;
  version: string | null;
};

export type CheckoutAllocationIssue = {
  wineId: string;
  reason: "missing_wine" | "stock_unavailable";
  requested: number;
  available: number;
};

export type CheckoutAllocation = {
  items: PickupItem[];
  bottleCount: number;
  issues: CheckoutAllocationIssue[];
};

const MaxQuantity = 2_147_483_647;
const MaxLines = 100;
const MaxNameLength = 80;
const MaxRecipients = 100;
const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !UuidPattern.test(value)) throw new Error("Checkout IDs must be UUIDs");
  return value.toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLocations(left: CheckoutStockRow, right: CheckoutStockRow): number {
  return compareText(left.fridge ?? "", right.fridge ?? "") ||
    compareText(left.shelf ?? "", right.shelf ?? "") ||
    compareText(left.locationId ?? "", right.locationId ?? "");
}

export function normalizeCheckoutDraft(value: unknown): CheckoutDraft {
  if (!isRecord(value) || !hasExactKeys(value, ["lines", "guestName", "additionalRecipientIds"])) {
    throw new Error("Checkout draft is invalid");
  }
  if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > MaxLines) {
    throw new Error("Checkout requires 1 to 100 wine lines");
  }
  if (typeof value.guestName !== "string") throw new Error("Guest name is invalid");
  const guestName = value.guestName.trim();
  if (guestName.length < 1 || guestName.length > MaxNameLength) throw new Error("Guest name must be 1 to 80 characters");
  if (!Array.isArray(value.additionalRecipientIds) || value.additionalRecipientIds.length > MaxRecipients) {
    throw new Error("Checkout recipients are invalid");
  }

  const lines = value.lines.map((candidate) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["wineId", "quantity"])) throw new Error("Checkout line is invalid");
    const wineId = normalizeUuid(candidate.wineId);
    if (!Number.isInteger(candidate.quantity) || Number(candidate.quantity) < 1 || Number(candidate.quantity) > MaxQuantity) {
      throw new Error("Checkout quantity is invalid");
    }
    return { wineId, quantity: Number(candidate.quantity) };
  });
  if (new Set(lines.map((line) => line.wineId)).size !== lines.length) throw new Error("Checkout wines must be unique");

  const additionalRecipientIds = value.additionalRecipientIds.map(normalizeUuid);
  if (new Set(additionalRecipientIds).size !== additionalRecipientIds.length) {
    throw new Error("Checkout recipients must be unique");
  }
  lines.sort((left, right) => compareText(left.wineId, right.wineId));
  additionalRecipientIds.sort(compareText);
  return { lines, guestName, additionalRecipientIds };
}

export function allocateCheckout(
  draft: CheckoutDraft,
  stockRows: readonly CheckoutStockRow[],
): CheckoutAllocation {
  const rowsByWine = new Map<string, CheckoutStockRow[]>();
  for (const row of stockRows) {
    const rows = rowsByWine.get(row.wineId) ?? [];
    rows.push(row);
    rowsByWine.set(row.wineId, rows);
  }

  const items: PickupItem[] = [];
  const issues: CheckoutAllocationIssue[] = [];
  let bottleCount = 0;

  const lines = [...draft.lines].sort((left, right) => compareText(left.wineId, right.wineId));
  for (const line of lines) {
    const wineRows = rowsByWine.get(line.wineId);
    if (!wineRows || wineRows.length === 0) {
      issues.push({ wineId: line.wineId, reason: "missing_wine", requested: line.quantity, available: 0 });
      continue;
    }

    const locations = wineRows
      .filter((row) =>
        row.locationId !== null &&
        row.fridge !== null &&
        row.shelf !== null &&
        Number.isInteger(row.quantity) &&
        Number(row.quantity) > 0,
      )
      .sort(compareLocations);
    const available = locations.reduce((total, row) => total + Number(row.quantity), 0);
    if (available < line.quantity) {
      issues.push({ wineId: line.wineId, reason: "stock_unavailable", requested: line.quantity, available });
    }

    let remaining = line.quantity;
    for (const row of locations) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, Number(row.quantity));
      items.push({
        wineId: line.wineId,
        locationId: row.locationId as string,
        producer: row.producer,
        wineName: row.wineName,
        vintage: row.vintage,
        bottleSizeMl: row.bottleSizeMl,
        fridge: row.fridge as string,
        shelf: row.shelf as string,
        quantity,
      });
      remaining -= quantity;
      bottleCount += quantity;
    }
  }

  return { items, bottleCount, issues };
}

export function resolveCheckoutRecipients(
  draft: CheckoutDraft,
  activeContacts: readonly CheckoutRecipient[],
): { recipients: CheckoutRecipient[]; issue: "host_unavailable" | "recipient_unavailable" | null } {
  const hosts = activeContacts.filter((contact) => contact.isHost);
  if (hosts.length !== 1) return { recipients: [], issue: "host_unavailable" };

  const contactsById = new Map(activeContacts.map((contact) => [contact.id.toLowerCase(), contact]));
  const selected = [...new Set(draft.additionalRecipientIds.map((id) => id.toLowerCase()))].sort(compareText);
  const recipients: CheckoutRecipient[] = [{
    id: hosts[0].id.toLowerCase(),
    displayName: hosts[0].displayName,
    isHost: true,
  }];
  for (const id of selected) {
    const contact = contactsById.get(id);
    if (!contact) return { recipients: [], issue: "recipient_unavailable" };
    if (id !== hosts[0].id.toLowerCase()) {
      recipients.push({ id, displayName: contact.displayName, isHost: contact.isHost });
    }
  }
  return { recipients, issue: null };
}

export function addReversalQuantity(currentQuantity: number, restoreQuantity: number): number {
  if (!Number.isInteger(currentQuantity) || currentQuantity < 0 || currentQuantity > MaxQuantity) {
    throw new RangeError("Current stock quantity is invalid");
  }
  if (!Number.isInteger(restoreQuantity) || restoreQuantity < 1 || restoreQuantity > MaxQuantity) {
    throw new RangeError("Restoration quantity is invalid");
  }
  const nextQuantity = currentQuantity + restoreQuantity;
  if (nextQuantity > MaxQuantity) throw new RangeError("Restored stock exceeds supported quantity");
  return nextQuantity;
}
