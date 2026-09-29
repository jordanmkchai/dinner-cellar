import { createHash } from "crypto";
import { canonicalJson, PolicyError } from "./inventoryPolicy";

export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export type PhotoReservationState = {
  status: string;
  requestHash: string | null;
  photoPath: string | null;
  expiresAt: Date | string | null;
};

export function photoUploadRequestHash(input: { contentType: PhotoContentType; sizeBytes: number }): string {
  const value = canonicalJson({ contentType: input.contentType, sizeBytes: input.sizeBytes });
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function decidePhotoReservationReplay(
  row: PhotoReservationState,
  requestHash: string,
  nowMs = Date.now(),
): { state: "ready"; photoPath: string } | { state: "pending" } {
  if (row.requestHash !== requestHash) {
    throw new PolicyError("Photo operation ID was already used for different upload details", 409, "OPERATION_REPLAY_MISMATCH");
  }
  if (row.status === "ready" && typeof row.photoPath === "string") {
    return { state: "ready", photoPath: row.photoPath };
  }
  if (row.status !== "pending") {
    throw new PolicyError("Photo upload reservation is invalid", 409, "PHOTO_UPLOAD_INVALID");
  }
  const expiry = row.expiresAt instanceof Date
    ? row.expiresAt.getTime()
    : typeof row.expiresAt === "string"
      ? Date.parse(row.expiresAt)
      : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    throw new PolicyError("Photo upload reservation expired. Start a new upload.", 410, "PHOTO_UPLOAD_EXPIRED");
  }
  return { state: "pending" };
}

export function assertPhotoReservationRateLimit(count: number, limit = 20): void {
  if (!Number.isSafeInteger(count) || count < 0 || count >= limit) {
    throw new PolicyError("Too many photo upload attempts. Try again later.", 429, "PHOTO_UPLOAD_RATE_LIMIT");
  }
}

export function isSafePublicPhotoPath(value: unknown): value is string {
  if (typeof value !== "string" || !/^\/_cdn\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

export function photoHeadUrl(photoPath: string, requestUrl: string): string {
  if (!isSafePublicPhotoPath(photoPath)) {
    throw new PolicyError("Photo path is invalid", 409, "PHOTO_UPLOAD_UNVERIFIED");
  }
  let base: URL;
  let url: URL;
  try {
    base = new URL(requestUrl);
    url = new URL(photoPath, base);
  } catch {
    throw new PolicyError("Photo path is invalid", 409, "PHOTO_UPLOAD_UNVERIFIED");
  }
  if (url.origin !== base.origin || url.search || url.hash || url.username || url.password) {
    throw new PolicyError("Photo path is invalid", 409, "PHOTO_UPLOAD_UNVERIFIED");
  }
  return url.href;
}

export function assertPhotoHead(
  response: Pick<Response, "status" | "redirected" | "headers">,
  expectedType: PhotoContentType,
  expectedSize: number,
): void {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    throw new PolicyError("Uploaded photo could not be verified. Try uploading again.", 409, "PHOTO_UPLOAD_UNVERIFIED");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const contentLength = response.headers.get("content-length");
  if (
    contentType !== expectedType || !contentLength || !/^\d+$/.test(contentLength) ||
    !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) !== expectedSize
  ) {
    throw new PolicyError("Uploaded photo does not match its reserved type and size", 409, "PHOTO_UPLOAD_UNVERIFIED");
  }
}
