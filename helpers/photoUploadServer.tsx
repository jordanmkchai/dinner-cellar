import { randomUUID } from "crypto";
import { sql } from "kysely";
import { db } from "./db";
import {
  type InventoryPrincipal,
  type InventoryTransaction,
} from "./inventoryServer";
import { PolicyError } from "./inventoryPolicy";
import {
  createWinePhotoUpload,
} from "./photoStorage";
import {
  assertPhotoHead,
  assertPhotoReservationRateLimit,
  decidePhotoReservationReplay,
  photoHeadUrl,
  photoUploadRequestHash,
  type PhotoContentType,
} from "./photoUploadPolicy";

const PHOTO_LIMIT = 5 * 1024 * 1024;
const RESERVATION_RATE_LIMIT = 20;
const RESERVATION_RATE_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
const HEAD_TIMEOUT_MS = 5_000;

type PhotoRow = {
  id: string;
  actorKey: string;
  operationId: string | null;
  requestHash: string | null;
  storageKey: string;
  photoPath: string | null;
  mimeType: string;
  sizeBytes: number;
  status: string;
  expiresAt: Date | string | null;
};

export type PhotoUploadInput = {
  operationId: string;
  sizeBytes: number;
  contentType: PhotoContentType;
};

export type PhotoUploadResult =
  | {
      ready: false;
      id: string;
      presignedUrl: string;
      putHeaders: { "Content-Type": PhotoContentType };
      expiresAt: string;
    }
  | { ready: true; id: string; photoPath: string };

function actorKey(principal: InventoryPrincipal): string {
  return principal.role === "host" ? `host:${principal.userId}` : `guest:${principal.guestLinkId}`;
}

function expiryDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function extension(contentType: PhotoContentType): string {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  return ".webp";
}

async function lockActor(trx: InventoryTransaction, actor: string): Promise<void> {
  const lockKey = "photo-reservation:" + actor;
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
}

function pendingResult(
  row: Pick<PhotoRow, "id" | "mimeType">,
  presignedUrl: string,
  expiresAt: Date,
): PhotoUploadResult {
  return {
    ready: false,
    id: row.id,
    presignedUrl,
    putHeaders: { "Content-Type": row.mimeType as PhotoContentType },
    expiresAt: expiresAt.toISOString(),
  };
}

async function mintPendingUrl(
  trx: InventoryTransaction,
  row: PhotoRow,
): Promise<PhotoUploadResult> {
  const mintedAt = Date.now();
  const upload = await createWinePhotoUpload({
    filename: row.storageKey,
    contentType: row.mimeType as PhotoContentType,
    sizeBytes: row.sizeBytes,
  });
  if (upload.storageKey !== row.storageKey || upload.photoPath !== row.photoPath) {
    throw new PolicyError("Photo storage could not resume this upload", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }
  const expiresAt = new Date(mintedAt + UPLOAD_URL_TTL_MS);
  await trx.updateTable("winePhotos").set({ expiresAt }).where("id", "=", row.id).execute();
  return pendingResult(row, upload.presignedUrl, expiresAt);
}

export async function reservePhotoUpload(
  principal: InventoryPrincipal,
  input: PhotoUploadInput,
): Promise<PhotoUploadResult> {
  if (input.sizeBytes < 1 || input.sizeBytes > PHOTO_LIMIT) {
    throw new PolicyError("Photo file must be 5 MB or smaller", 413, "PHOTO_TOO_LARGE");
  }
  const actor = actorKey(principal);
  const operationId = input.operationId.toLowerCase();
  const hash = photoUploadRequestHash(input);

  return db.transaction().execute(async (trx) => {
    await lockActor(trx, actor);
    const prior = await trx
      .selectFrom("winePhotos")
      .select(["id", "actorKey", "operationId", "requestHash", "storageKey", "photoPath", "mimeType", "sizeBytes", "status", "expiresAt"])
      .where("actorKey", "=", actor)
      .where("operationId", "=", operationId)
      .forUpdate()
      .executeTakeFirst() as PhotoRow | undefined;

    if (prior) {
      const replay = decidePhotoReservationReplay(prior, hash);
      if (replay.state === "ready") return { ready: true, id: prior.id, photoPath: replay.photoPath };
      return mintPendingUrl(trx, prior);
    }

    const windowStart = new Date(Date.now() - RESERVATION_RATE_WINDOW_MS);
    const count = await trx
      .selectFrom("winePhotos")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("actorKey", "=", actor)
      .where("createdAt", ">", windowStart)
      .executeTakeFirst();
    assertPhotoReservationRateLimit(Number(count?.count ?? 0), RESERVATION_RATE_LIMIT);

    const id = randomUUID();
    const storageKey = "wine-photos/" + id + extension(input.contentType);
    const mintedAt = Date.now();
    const upload = await createWinePhotoUpload({
      filename: storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
    const expiresAt = new Date(mintedAt + UPLOAD_URL_TTL_MS);
    const row: PhotoRow = {
      id,
      actorKey: actor,
      operationId,
      requestHash: hash,
      storageKey,
      photoPath: upload.photoPath,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: "pending",
      expiresAt,
    };
    await trx.insertInto("winePhotos").values({
      id,
      actorKey: actor,
      operationId,
      requestHash: hash,
      storageKey,
      photoPath: upload.photoPath,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: "pending",
      expiresAt,
    }).execute();
    return pendingResult(row, upload.presignedUrl, expiresAt);
  });
}

async function verifyStoredPhoto(request: Request, photo: PhotoRow): Promise<void> {
  if (typeof photo.photoPath !== "string") {
    throw new PolicyError("Photo upload reservation is invalid", 409, "PHOTO_UPLOAD_INVALID");
  }
  const url = photoHeadUrl(photo.photoPath, request.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    assertPhotoHead(response, photo.mimeType as PhotoContentType, photo.sizeBytes);
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("Photo verification is temporarily unavailable. Retry finalize.", 503, "PHOTO_VERIFY_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

export async function finalizePhotoUpload(
  request: Request,
  principal: InventoryPrincipal,
  photoId: string,
): Promise<{ id: string; photoPath: string }> {
  const actor = actorKey(principal);
  return db.transaction().execute(async (trx) => {
    const photo = await trx
      .selectFrom("winePhotos")
      .select(["id", "actorKey", "operationId", "requestHash", "storageKey", "photoPath", "mimeType", "sizeBytes", "status", "expiresAt"])
      .where("id", "=", photoId.toLowerCase())
      .where("actorKey", "=", actor)
      .forUpdate()
      .executeTakeFirst() as PhotoRow | undefined;
    if (!photo) throw new PolicyError("Photo upload receipt not found", 404, "PHOTO_NOT_FOUND");
    if (photo.status === "ready" && typeof photo.photoPath === "string") {
      return { id: photo.id, photoPath: photo.photoPath };
    }
    if (photo.status !== "pending") {
      throw new PolicyError("Photo upload reservation is invalid", 409, "PHOTO_UPLOAD_INVALID");
    }
    const expiresAt = expiryDate(photo.expiresAt);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new PolicyError("Photo upload reservation expired. Start a new upload.", 410, "PHOTO_UPLOAD_EXPIRED");
    }

    await verifyStoredPhoto(request, photo);
    await trx.updateTable("winePhotos").set({ status: "ready", expiresAt: null }).where("id", "=", photo.id).execute();
    if (typeof photo.photoPath !== "string") {
      throw new PolicyError("Photo upload reservation is invalid", 409, "PHOTO_UPLOAD_INVALID");
    }
    return { id: photo.id, photoPath: photo.photoPath };
  });
}
