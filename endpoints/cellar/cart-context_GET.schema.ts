import superjson from "superjson";
import type { CatalogWine } from "../../helpers/wineCatalog";
import type { CartContext, CartRecipient } from "../../helpers/cartPolicy";

export type OutputType = CartContext;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isCatalogWine(value: unknown): value is CatalogWine {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "producer", "wineName", "vintage", "country", "region", "subregion", "appellation",
    "grapeBlend", "colour", "wineStyle", "sweetness", "bottleSizeMl", "photoPath", "totalQuantity", "locations",
  ])) return false;
  const nullableStrings = ["vintage", "country", "region", "subregion", "appellation", "grapeBlend", "colour", "wineStyle", "sweetness", "photoPath"];
  if (!isUuid(value.id) || typeof value.producer !== "string" || typeof value.wineName !== "string") return false;
  if (nullableStrings.some((key) => value[key] !== null && typeof value[key] !== "string")) return false;
  if (!Number.isInteger(value.bottleSizeMl) || Number(value.bottleSizeMl) <= 0) return false;
  if (typeof value.totalQuantity !== "number" || !Number.isFinite(value.totalQuantity) || value.totalQuantity < 0) return false;
  if (!Array.isArray(value.locations)) return false;
  return value.locations.every((location) =>
    isRecord(location) &&
    hasExactKeys(location, ["locationId", "fridge", "shelf", "quantity"]) &&
    isUuid(location.locationId) &&
    typeof location.fridge === "string" &&
    typeof location.shelf === "string" &&
    Number.isInteger(location.quantity) &&
    Number(location.quantity) > 0,
  );
}

function isCartRecipient(value: unknown): value is CartRecipient {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "displayName", "isHost"]) &&
    isUuid(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.isHost === "boolean";
}

function isCartContext(value: unknown): value is CartContext {
  if (!isRecord(value) || !hasExactKeys(value, ["scope", "role", "wines", "recipients", "hostRecipientId"])) return false;
  if (typeof value.scope !== "string" || !/^cart-v1:[a-f0-9]{64}$/.test(value.scope)) return false;
  if (value.role !== "host" && value.role !== "guest") return false;
  if (!Array.isArray(value.wines) || !value.wines.every(isCatalogWine)) return false;
  if (!Array.isArray(value.recipients) || !value.recipients.every(isCartRecipient)) return false;
  if (value.hostRecipientId !== null && !isUuid(value.hostRecipientId)) return false;
  const wineIds = value.wines.map((wine) => wine.id);
  const recipientIds = value.recipients.map((recipient) => recipient.id);
  if (new Set(wineIds).size !== wineIds.length || new Set(recipientIds).size !== recipientIds.length) return false;
  const hosts = value.recipients.filter((recipient) => recipient.isHost);
  return hosts.length <= 1 && (value.hostRecipientId === null
    ? hosts.length === 0
    : hosts.length === 1 && hosts[0].id === value.hostRecipientId);
}

export async function getCartContext(init?: RequestInit): Promise<CartContext | null> {
  let response: Response;
  try {
    response = await fetch("/_api/cellar/cart-context", {
      ...init,
      method: "GET",
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw new Error("Cellar cart context unavailable");
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Cellar cart context unavailable");

  let payload: unknown;
  try {
    payload = superjson.parse<unknown>(await response.text());
  } catch {
    throw new Error("Cellar cart context unavailable");
  }
  if (!isCartContext(payload)) throw new Error("Cellar cart context unavailable");
  return payload;
}
