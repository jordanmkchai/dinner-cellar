import { createHash } from "crypto";
import superjson from "superjson";
import { sql } from "kysely";
import { ZodError } from "zod";
import { db } from "./db";
import { cellarAccess } from "./cellarAccess";
import {
  assertOperationReplay,
  canonicalJson,
  normalizeLocation,
  PolicyError,
  wineCategoryValues,
  type WineInput,
} from "./inventoryPolicy";

type TransactionCallback = Parameters<ReturnType<typeof db.transaction>["execute"]>[0];
export type InventoryTransaction = TransactionCallback extends (trx: infer T) => unknown ? T : never;
export type InventoryPrincipal =
  | { role: "host"; userId: number }
  | { role: "guest"; guestLinkId: string };

const MAX_BODY_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Inventory operation result contains an invalid number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => toJsonValue(item));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Inventory operation result contains unsupported data");
    }
    const output: JsonObject = Object.create(null) as JsonObject;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonValue(item);
    }
    return output;
  }
  throw new Error("Inventory operation result contains unsupported data");
}

function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);
  if (!isJsonObject(converted)) throw new Error("Inventory operation result must be a JSON object");
  return converted;
}

export async function requireInventoryAccess(
  request: Request,
  hostOnly = false,
  mutation = false,
): Promise<InventoryPrincipal> {
  if (mutation && !cellarAccess.isSameOrigin(request)) {
    throw new PolicyError("Request rejected", 403, "ORIGIN_REJECTED");
  }

  if (hostOnly) {
    const host = await cellarAccess.requireHost(request);
    if (!host) throw new PolicyError("Host access required", 401, "HOST_REQUIRED");
    return { role: "host", userId: host.userId };
  }

  const access = await cellarAccess.requireAccess(request);
  if (!access) throw new PolicyError("Access required", 401, "ACCESS_REQUIRED");
  return access.role === "host"
    ? { role: "host", userId: access.userId }
    : { role: "guest", guestLinkId: access.guestLinkId };
}

export async function readInventoryBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new PolicyError("JSON request body required", 415, "JSON_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new PolicyError("Request body is invalid", 400, "INVALID_BODY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new PolicyError("Request body is too large", 413, "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return superjson.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PolicyError("Request body is invalid", 400, "INVALID_BODY");
  }
}

export function inventoryJson(body: unknown, status = 200): Response {
  return new Response(superjson.stringify(body), { status, headers: responseHeaders });
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

export function inventoryError(error: unknown): Response {
  if (error instanceof PolicyError) {
    return inventoryJson({ code: error.code, message: error.message }, error.status);
  }
  if (error instanceof ZodError) {
    return inventoryJson({ code: "INVALID_INPUT", message: "Request data is invalid" }, 400);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = safeErrorCode(error);
  console.error("Inventory request failed", { errorClass: name.slice(0, 80), ...(code ? { code } : {}) });
  return inventoryJson({ code: "INTERNAL_ERROR", message: "Unable to complete request" }, 500);
}

function actorKey(principal: InventoryPrincipal): string {
  return principal.role === "host" ? `host:${principal.userId}` : `guest:${principal.guestLinkId}`;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = safeErrorCode(error);
  return code === "40001" || code === "40P01";
}

export async function withInventoryOperation<T extends object>(
  principal: InventoryPrincipal,
  operationId: string,
  kind: string,
  payload: unknown,
  run: (trx: InventoryTransaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(operationId)) throw new PolicyError("Operation ID must be a UUID", 400, "INVALID_OPERATION_ID");
  if (typeof kind !== "string" || kind.trim().length < 1 || kind.length > 80) {
    throw new PolicyError("Operation type is invalid", 400, "INVALID_OPERATION");
  }

  const requestHash = createHash("sha256")
    .update(canonicalJson({ kind: kind.trim(), payload }), "utf8")
    .digest("hex");
  const currentActorKey = actorKey(principal);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction().execute(async (trx) => {
        const claim = await trx
          .insertInto("inventoryOperations")
          .values({
            actorKey: currentActorKey,
            operationId: operationId.toLowerCase(),
            requestHash,
            result: {},
          })
          .onConflict((conflict) => conflict.columns(["actorKey", "operationId"]).doNothing())
          .returning("operationId")
          .executeTakeFirst();

        if (!claim) {
          const prior = await trx
            .selectFrom("inventoryOperations")
            .select(["requestHash", "result"])
            .where("actorKey", "=", currentActorKey)
            .where("operationId", "=", operationId.toLowerCase())
            .forUpdate()
            .executeTakeFirst();
          if (!prior) throw new Error("Inventory operation claim disappeared");
          assertOperationReplay(prior.requestHash, requestHash);
          if (typeof prior.result !== "object" || prior.result === null || Array.isArray(prior.result)) {
            throw new Error("Stored inventory operation result is invalid");
          }
          return prior.result as T;
        }

        const result = await run(trx);
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new Error("Inventory operations must return an object");
        }
        const parsedResult: unknown = JSON.parse(canonicalJson(result));
        const storedResult = toJsonObject(parsedResult);
        await trx
          .updateTable("inventoryOperations")
          .set({ result: storedResult })
          .where("actorKey", "=", currentActorKey)
          .where("operationId", "=", operationId.toLowerCase())
          .execute();
        return result;
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= 2) throw error;
    }
  }
}

export async function lockWine(trx: InventoryTransaction, wineId: string): Promise<void> {
  const wine = await trx
    .selectFrom("wines")
    .select("id")
    .where("id", "=", wineId)
    .forUpdate()
    .executeTakeFirst();
  if (!wine) throw new PolicyError("Wine not found", 404, "WINE_NOT_FOUND");
}

export async function ensureLocation(
  trx: InventoryTransaction,
  fridgeValue: unknown,
  shelfValue: unknown,
): Promise<string> {
  const fridge = normalizeLocation(fridgeValue);
  const shelf = normalizeLocation(shelfValue);
  const fridgeKey = fridge.toLocaleLowerCase("en");
  const shelfKey = shelf.toLocaleLowerCase("en");
  const lockKey = `inventory-location:${canonicalJson([fridgeKey, shelfKey])}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);

  const existing = await trx
    .selectFrom("locations")
    .select("id")
    .where(sql<string>`lower(trim(fridge))`, "=", fridgeKey)
    .where(sql<string>`lower(trim(shelf))`, "=", shelfKey)
    .orderBy("id")
    .executeTakeFirst();
  if (existing) return existing.id;

  const created = await trx
    .insertInto("locations")
    .values({ fridge, shelf })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

export async function saveCategoryOptions(trx: InventoryTransaction, wine: WineInput): Promise<void> {
  const values = wineCategoryValues(wine).map(({ fieldName, value }) => ({ fieldName, value }));
  if (values.length === 0) return;
  await trx.insertInto("categoryOptions").values(values).onConflict((conflict) => conflict.doNothing()).execute();
}

export async function resolveWinePhoto(
  trx: InventoryTransaction,
  principal: InventoryPrincipal,
  photoId: string | null | undefined,
  currentPath: string | null,
): Promise<string | null> {
  if (photoId === undefined) return currentPath;
  if (photoId === null) return null;
  if (!UUID.test(photoId)) throw new PolicyError("Photo selection is invalid", 400, "INVALID_PHOTO");

  const photo = await trx
    .selectFrom("winePhotos")
    .select("photoPath")
    .where("id", "=", photoId.toLowerCase())
    .where("status", "=", "ready")
    .where("actorKey", "=", actorKey(principal))
    .executeTakeFirst();
  if (!photo) throw new PolicyError("Photo upload receipt is invalid", 400, "INVALID_PHOTO");
  return photo.photoPath;
}
