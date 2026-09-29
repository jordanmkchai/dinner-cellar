import type { CatalogWine } from "./wineCatalog";

export type CartLine = { wineId: string; quantity: number };
export type CartDraft = {
  lines: CartLine[];
  guestName: string;
  additionalRecipientIds: string[];
};
export type CartRecipient = { id: string; displayName: string; isHost: boolean };
export type CartContext = {
  scope: string;
  role: "host" | "guest";
  wines: CatalogWine[];
  recipients: CartRecipient[];
  hostRecipientId: string | null;
};

const MaxQuantity = 2_147_483_647;
const MaxLines = 100;
const MaxNameLength = 80;
const MaxRecipients = 100;
const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UuidPattern.test(value);
}

function isQuantity(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MaxQuantity;
}

function requireWine(wineId: string, wines: readonly CatalogWine[]): CatalogWine {
  if (!isUuid(wineId)) throw new Error("Wine is unavailable");
  const wine = wines.find((candidate) => candidate.id === wineId);
  if (!wine) throw new Error("Wine is unavailable");
  if (!Number.isFinite(wine.totalQuantity) || wine.totalQuantity <= 0) {
    throw new Error("Wine has no current stock");
  }
  return wine;
}

export function emptyCart(): CartDraft {
  return { lines: [], guestName: "", additionalRecipientIds: [] };
}

export function sanitizeStoredCart(value: unknown): CartDraft | null {
  if (!isRecord(value) || !hasExactKeys(value, ["lines", "guestName", "additionalRecipientIds"])) return null;
  const { lines, guestName, additionalRecipientIds } = value;
  if (!Array.isArray(lines) || lines.length > MaxLines || typeof guestName !== "string" || guestName.length > MaxNameLength) return null;
  if (!Array.isArray(additionalRecipientIds) || additionalRecipientIds.length > MaxRecipients) return null;

  const seenWines = new Set<string>();
  const cleanLines: CartLine[] = [];
  for (const candidate of lines) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["wineId", "quantity"])) return null;
    if (!isUuid(candidate.wineId) || !isQuantity(candidate.quantity) || seenWines.has(candidate.wineId)) return null;
    seenWines.add(candidate.wineId);
    cleanLines.push({ wineId: candidate.wineId, quantity: candidate.quantity });
  }

  const seenRecipients = new Set<string>();
  const cleanRecipientIds: string[] = [];
  for (const id of additionalRecipientIds) {
    if (!isUuid(id) || seenRecipients.has(id)) return null;
    seenRecipients.add(id);
    cleanRecipientIds.push(id);
  }

  return { lines: cleanLines, guestName, additionalRecipientIds: cleanRecipientIds };
}

export function addCartLine(
  draft: CartDraft,
  wineId: string,
  amount: number,
  wines: readonly CatalogWine[],
): CartDraft {
  const wine = requireWine(wineId, wines);
  if (!isQuantity(amount)) throw new Error("Quantity must be a positive whole number");
  const index = draft.lines.findIndex((line) => line.wineId === wineId);
  if (index < 0) {
    if (draft.lines.length >= MaxLines) throw new Error("Cart can contain at most 100 wines");
    if (amount > wine.totalQuantity) throw new Error("Requested quantity exceeds current stock");
    return { ...draft, lines: [...draft.lines, { wineId, quantity: amount }] };
  }
  const current = draft.lines[index];
  const quantity = current.quantity + amount;
  if (!isQuantity(current.quantity) || !isQuantity(quantity)) throw new Error("Requested quantity is too large");
  if (quantity > wine.totalQuantity) throw new Error("Requested quantity exceeds current stock");
  return {
    ...draft,
    lines: draft.lines.map((line, lineIndex) => lineIndex === index ? { ...line, quantity } : line),
  };
}

export function setCartQuantity(
  draft: CartDraft,
  wineId: string,
  quantity: number,
  wines: readonly CatalogWine[],
): CartDraft {
  if (!isQuantity(quantity)) throw new Error("Quantity must be a positive whole number");
  const wine = wines.find((candidate) => candidate.id === wineId);
  const current = draft.lines.find((line) => line.wineId === wineId);
  if (!isUuid(wineId) || !wine || !current) throw new Error("Cart line is unavailable");
  if (quantity > current.quantity && (wine.totalQuantity <= 0 || quantity > wine.totalQuantity)) {
    throw new Error("Requested quantity exceeds current stock");
  }
  return {
    ...draft,
    lines: draft.lines.map((line) => line.wineId === wineId ? { ...line, quantity } : line),
  };
}

export function removeCartLine(draft: CartDraft, wineId: string): CartDraft {
  return { ...draft, lines: draft.lines.filter((line) => line.wineId !== wineId) };
}

export function cartBottleCount(draft: CartDraft): number {
  return draft.lines.reduce((total, line) => total + line.quantity, 0);
}

type ReviewedLine = {
  wineId: string;
  quantity: number;
  wine: CatalogWine | null;
  available: number;
  issue: string | null;
};

export function reviewCart(
  draft: CartDraft,
  context: CartContext,
): { ready: boolean; issues: string[]; lines: ReviewedLine[]; recipientIds: string[] } {
  const issues: string[] = [];
  const guestName = typeof draft.guestName === "string" ? draft.guestName.trim() : "";
  if (guestName.length === 0) issues.push("Enter guest name");
  else if (guestName.length > MaxNameLength) issues.push("Guest name must be 80 characters or fewer");
  if (draft.lines.length === 0) issues.push("Add at least one wine");

  const winesById = new Map(context.wines.map((wine) => [wine.id, wine]));
  const lines = draft.lines.map((line): ReviewedLine => {
    const wine = winesById.get(line.wineId) ?? null;
    const available = wine && Number.isFinite(wine.totalQuantity) ? Math.max(0, wine.totalQuantity) : 0;
    let issue: string | null = null;
    if (!wine) issue = "Wine no longer exists in cellar";
    else if (!isQuantity(line.quantity)) issue = "Quantity must be a positive whole number";
    else if (available <= 0) issue = "No bottles currently available";
    else if (line.quantity > available) issue = `Only ${available} bottle${available === 1 ? "" : "s"} currently available`;
    if (issue) issues.push(issue);
    return { wineId: line.wineId, quantity: line.quantity, wine, available, issue };
  });

  const activeHost = context.hostRecipientId
    ? context.recipients.find((recipient) => recipient.id === context.hostRecipientId && recipient.isHost)
    : undefined;
  if (!activeHost || context.recipients.filter((recipient) => recipient.isHost).length !== 1) {
    issues.push("Host recipient is currently unavailable");
  }

  const recipientIds: string[] = [];
  if (activeHost) recipientIds.push(activeHost.id);
  const activeRecipients = new Map(context.recipients.map((recipient) => [recipient.id, recipient]));
  const seenRecipients = new Set(recipientIds);
  for (const id of draft.additionalRecipientIds) {
    if (!activeRecipients.has(id)) {
      issues.push("A selected recipient is no longer active; remove it");
      continue;
    }
    if (!seenRecipients.has(id)) {
      recipientIds.push(id);
      seenRecipients.add(id);
    }
  }

  return { ready: issues.length === 0, issues, lines, recipientIds };
}
