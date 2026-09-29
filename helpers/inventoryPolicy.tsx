export type WineInput = {
  producer: string;
  wineName: string;
  vintage: string | null;
  country: string | null;
  region: string | null;
  subregion: string | null;
  appellation: string | null;
  grapeBlend: string | null;
  colour: string | null;
  wineStyle: string | null;
  sweetness: string | null;
  bottleSizeMl: number;
  photoId?: string | null;
};

const MAX_INTEGER = 2_147_483_647;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PolicyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "INVALID_INPUT") {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.code = code;
  }
}

export function emptyWineInput(): WineInput {
  return {
    producer: "",
    wineName: "",
    vintage: null,
    country: null,
    region: null,
    subregion: null,
    appellation: null,
    grapeBlend: null,
    colour: null,
    wineStyle: null,
    sweetness: null,
    bottleSizeMl: 750,
    photoId: null,
  };
}

function text(value: unknown, field: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new PolicyError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new PolicyError(`${field} must be text`);
  const normalized = value.trim();
  if (normalized.length > 300) throw new PolicyError(`${field} must be 300 characters or fewer`);
  if (required && normalized.length === 0) throw new PolicyError(`${field} is required`);
  return normalized.length === 0 ? (required ? "" : null) : normalized;
}

export function normalizeWineInput(value: unknown): WineInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyError("Wine details are required");
  }
  const raw = value as Record<string, unknown>;
  const wine: WineInput = {
    producer: text(raw.producer, "Producer", true) ?? "",
    wineName: text(raw.wineName, "Wine name", true) ?? "",
    vintage: text(raw.vintage, "Vintage"),
    country: text(raw.country, "Country"),
    region: text(raw.region, "Region"),
    subregion: text(raw.subregion, "Subregion"),
    appellation: text(raw.appellation, "Appellation"),
    grapeBlend: text(raw.grapeBlend, "Grape / blend"),
    colour: text(raw.colour, "Colour"),
    wineStyle: text(raw.wineStyle, "Wine style"),
    sweetness: text(raw.sweetness, "Sweetness"),
    bottleSizeMl: quantity(raw.bottleSizeMl),
  };

  if (Object.hasOwn(raw, "photoId") && raw.photoId !== undefined) {
    if (raw.photoId === null) wine.photoId = null;
    else if (typeof raw.photoId === "string" && UUID.test(raw.photoId)) wine.photoId = raw.photoId.toLowerCase();
    else throw new PolicyError("Photo selection is invalid", 400, "INVALID_PHOTO");
  }
  return wine;
}

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new PolicyError("Name is required");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80) {
    throw new PolicyError("Name must be 1 to 80 characters");
  }
  return normalized;
}

export function normalizeLocation(value: unknown): string {
  if (typeof value !== "string") throw new PolicyError("Location is required");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80) {
    throw new PolicyError("Location must be 1 to 80 characters");
  }
  return normalized;
}

export function quantity(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_INTEGER
  ) {
    throw new PolicyError(allowZero ? "Quantity must be a whole number from 0 to 2147483647" : "Quantity must be a positive whole number");
  }
  return value;
}

export function stockTotal(current: number, delta: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current > MAX_INTEGER) {
    throw new PolicyError("Current stock is invalid", 409, "STOCK_CONFLICT");
  }
  if (!Number.isSafeInteger(delta)) throw new PolicyError("Stock change must be a whole number");
  const total = current + delta;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_INTEGER) {
    throw new PolicyError("Stock change would exceed available limits", 409, "STOCK_CONFLICT");
  }
  return total;
}

function parseVersion(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PolicyError(`${label} is invalid`, 400, "INVALID_VERSION");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_BIGINT) throw new PolicyError(`${label} is invalid`, 400, "INVALID_VERSION");
  return parsed;
}

export function assertVersion(actual: string, expected: string): void {
  const current = parseVersion(actual, "Current version");
  const supplied = parseVersion(expected, "Expected version");
  if (current !== supplied) {
    throw new PolicyError("This record changed. Reload it and review your edits.", 409, "VERSION_CONFLICT");
  }
}

function normalizedIdentityPart(value: string | null): string {
  return (value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").trim();
}

export function normalizedWineIdentity(wine: WineInput): string {
  return canonicalJson([
    normalizedIdentityPart(wine.producer),
    normalizedIdentityPart(wine.wineName),
    normalizedIdentityPart(wine.vintage),
    wine.bottleSizeMl,
  ]);
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") throw new PolicyError("Phone number is required");
  const phone = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
    throw new PolicyError("Enter a phone number with country code, such as +14155550123");
  }
  return phone;
}

function canonicalValue(value: unknown, stack: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PolicyError("Request contains an invalid number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new PolicyError("Request cannot contain circular data");
    stack.add(value);
    const result = value.map((item) => {
      if (item === undefined) return null;
      return canonicalValue(item, stack);
    });
    stack.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new PolicyError("Request contains unsupported data");
    }
    if (stack.has(value)) throw new PolicyError("Request cannot contain circular data");
    stack.add(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = canonicalValue(item, stack);
    }
    stack.delete(value);
    return result;
  }
  throw new PolicyError("Request contains unsupported data");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()));
}

export function assertOperationReplay(storedHash: string, candidateHash: string): void {
  if (storedHash !== candidateHash) {
    throw new PolicyError("Operation ID was already used for different changes", 409, "IDEMPOTENCY_KEY_REUSED");
  }
}

export const wineCategoryFields = {
  producer: "producer",
  wineName: "wine_name",
  vintage: "vintage",
  country: "country",
  region: "region",
  subregion: "subregion",
  appellation: "appellation",
  grapeBlend: "grape_blend",
  colour: "colour",
  wineStyle: "wine_style",
  sweetness: "sweetness",
  bottleSizeMl: "bottle_size_ml",
} as const;

export type WineCategoryKey = keyof typeof wineCategoryFields;

export function wineCategoryValues(wine: WineInput): Array<{ fieldName: string; value: string }> {
  return (Object.keys(wineCategoryFields) as WineCategoryKey[])
    .map((key) => ({
      fieldName: wineCategoryFields[key],
      value: key === "bottleSizeMl" ? String(wine.bottleSizeMl) : (wine[key] as string | null) ?? "",
    }))
    .filter(({ value }) => value.trim() !== "");
}
