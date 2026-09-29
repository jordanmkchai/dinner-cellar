export const MAX_WINE_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_WINE_PHOTO_DIMENSION = 12_000;
export const MAX_WINE_PHOTO_PIXELS = 40_000_000;

export type WinePhotoContentType = "image/jpeg" | "image/png" | "image/webp";
export type WinePhotoMetadata = {
  operationId: string;
  sizeBytes: number;
  contentType: WinePhotoContentType;
};
export type WinePhotoTarget =
  | { ready: true; id: string; photoPath: string }
  | {
      ready: false;
      id: string;
      presignedUrl: string;
      putHeaders: Record<string, string>;
      expiresAt: string;
    };
export type WinePhotoResult = { id: string; photoPath: string };
export type UploadFailure = Error & { status?: number; code?: string; uncertain: boolean; storageStatus?: number };

export type PhotoUploadDependencies = {
  fetcher?: typeof fetch;
  decodeImage?: (file: Blob) => Promise<{ width: number; height: number }>;
  encodeJson?: (value: unknown) => string;
  decodeJson?: (response: Response) => Promise<unknown>;
  decodeError?: (response: Response) => Promise<{ message?: string; code?: string }>;
  now?: () => number;
};

const contentTypes = new Set<WinePhotoContentType>(["image/jpeg", "image/png", "image/webp"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationIds = new WeakMap<object, string>();

export function photoOperationIdFor(file: object, create: () => string): string {
  const existing = operationIds.get(file);
  if (existing) return existing;
  const operationId = create();
  if (!uuidPattern.test(operationId)) throw failure("Secure photo upload is unavailable in this browser", 400, "SECURE_ID_UNAVAILABLE");
  operationIds.set(file, operationId);
  return operationId;
}

export function clearPhotoOperationId(file: object): void {
  operationIds.delete(file);
}

export function clearPhotoOperationIfExpired(file: object, error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "PHOTO_UPLOAD_EXPIRED" && code !== "UPLOAD_EXPIRED") return false;
  clearPhotoOperationId(file);
  return true;
}

function failure(message: string, status?: number, code?: string): UploadFailure {
  const error = new Error(message) as UploadFailure;
  error.status = status;
  error.code = code;
  error.uncertain = status === undefined || status >= 500;
  return error;
}

function dimensionsWithinBounds(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= MAX_WINE_PHOTO_DIMENSION && height <= MAX_WINE_PHOTO_DIMENSION &&
    width * height <= MAX_WINE_PHOTO_PIXELS;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] };
    }
    offset += segmentLength;
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n" || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const declaredEnd = Math.min(bytes.length, readU32LE(bytes, 4) + 8);
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const kind = ascii(bytes, offset, 4);
    const length = readU32LE(bytes, offset + 4);
    const start = offset + 8;
    if (length > declaredEnd - start) return null;
    if (kind === "VP8X" && length >= 10) {
      return { width: readU24LE(bytes, start + 4) + 1, height: readU24LE(bytes, start + 7) + 1 };
    }
    if (kind === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const b1 = bytes[start + 1], b2 = bytes[start + 2], b3 = bytes[start + 3], b4 = bytes[start + 4];
      return {
        width: 1 + ((b1 | ((b2 & 0x3f) << 8)) & 0x3fff),
        height: 1 + (((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) & 0x3fff),
      };
    }
    if (kind === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return {
        width: ((bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff),
        height: ((bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff),
      };
    }
    offset = start + length + (length & 1);
  }
  return null;
}

function inspectSignatureAndDimensions(bytes: Uint8Array): { contentType: WinePhotoContentType; width: number; height: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegDimensions(bytes);
    return size ? { contentType: "image/jpeg", ...size } : null;
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((value, index) => bytes[index] === value)) {
    const size = pngDimensions(bytes);
    return size ? { contentType: "image/png", ...size } : null;
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const size = webpDimensions(bytes);
    return size ? { contentType: "image/webp", ...size } : null;
  }
  return null;
}

export async function decodeBrowserImage(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("This browser cannot verify image dimensions.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    if (typeof image.decode === "function") {
      image.src = url;
      await image.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Photo could not be decoded."));
        image.src = url;
      });
    }
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseTarget(value: unknown): WinePhotoTarget | null {
  const record = parseRecord(value);
  if (!record || typeof record.id !== "string" || !uuidPattern.test(record.id)) return null;
  if (record.ready === true && typeof record.photoPath === "string" && record.photoPath.length > 0) {
    return { ready: true, id: record.id, photoPath: record.photoPath };
  }
  const putHeaders = parseRecord(record.putHeaders);
  if (record.ready !== false || typeof record.presignedUrl !== "string" || typeof record.expiresAt !== "string" || !putHeaders) return null;
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(putHeaders)) {
    if (name.toLowerCase() !== "content-type" || typeof value !== "string") return null;
    safeHeaders[name] = value;
  }
  if (Object.keys(safeHeaders).length !== 1) return null;
  return {
    ready: false,
    id: record.id,
    presignedUrl: record.presignedUrl,
    putHeaders: safeHeaders,
    expiresAt: record.expiresAt,
  };
}

function parseResult(value: unknown, expectedId: string): WinePhotoResult | null {
  const record = parseRecord(value);
  if (!record || record.id !== expectedId || typeof record.photoPath !== "string" || record.photoPath.length === 0) return null;
  return { id: expectedId, photoPath: record.photoPath };
}

async function defaultDecode(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

async function defaultDecodeError(response: Response): Promise<{ message?: string; code?: string }> {
  try {
    const record = parseRecord(await defaultDecode(response));
    return {
      ...(typeof record?.message === "string" ? { message: record.message } : {}),
      ...(typeof record?.code === "string" ? { code: record.code } : {}),
    };
  } catch { return {}; }
}

async function postJson(
  path: string,
  body: unknown,
  options: Required<Pick<PhotoUploadDependencies, "fetcher" | "encodeJson" | "decodeJson" | "decodeError">> & { signal?: AbortSignal },
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetcher(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: options.encodeJson(body),
      signal: options.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw failure("Photo upload connection failed");
  }
  if (!response.ok) {
    const bodyError = await options.decodeError(response);
    throw failure(bodyError.message || "Photo upload failed", response.status, bodyError.code);
  }
  try { return await options.decodeJson(response); }
  catch { throw failure("Photo upload response was incomplete", response.status); }
}

export async function postUploadWinePhotoDirect(
  file: File,
  operationId: string,
  dependencies: PhotoUploadDependencies = {},
  signal?: AbortSignal,
): Promise<WinePhotoResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const decodeImage = dependencies.decodeImage ?? decodeBrowserImage;
  const encodeJson = dependencies.encodeJson ?? ((value) => JSON.stringify(value));
  const decodeJson = dependencies.decodeJson ?? defaultDecode;
  const decodeError = dependencies.decodeError ?? defaultDecodeError;
  const now = dependencies.now ?? Date.now;
  if (!uuidPattern.test(operationId)) throw failure("Photo upload operation is invalid", 400, "INVALID_INPUT");
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_WINE_PHOTO_BYTES) {
    throw failure("Photo must be larger than 0 bytes and 5 MB or smaller.", 400, "INVALID_PHOTO");
  }
  const declaredType = String(file.type ?? "").toLowerCase();
  if (!contentTypes.has(declaredType as WinePhotoContentType)) {
    throw failure("Choose JPEG, PNG, or WebP photo.", 400, "INVALID_PHOTO");
  }

  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw failure("Photo could not be read. Choose it again.", 400, "INVALID_PHOTO"); }
  const inspected = inspectSignatureAndDimensions(bytes);
  if (!inspected || inspected.contentType !== declaredType || !dimensionsWithinBounds(inspected.width, inspected.height)) {
    throw failure("Photo content is invalid or its dimensions exceed the supported limit.", 400, "INVALID_PHOTO");
  }
  let decoded: { width: number; height: number };
  try { decoded = await decodeImage(file); }
  catch { throw failure("Photo is not a valid decodable image.", 400, "INVALID_PHOTO"); }
  if (!dimensionsWithinBounds(decoded.width, decoded.height)) {
    throw failure("Photo dimensions exceed the supported limit.", 400, "INVALID_PHOTO");
  }

  const metadata: WinePhotoMetadata = { operationId, sizeBytes: file.size, contentType: inspected.contentType };
  const requestOptions = { fetcher, encodeJson, decodeJson, decodeError, signal };
  const rawTarget = await postJson("/_api/cellar/photo-upload", metadata, requestOptions);
  const target = parseTarget(rawTarget);
  if (!target) throw failure("Photo upload response was incomplete", undefined, "INVALID_RESPONSE");
  if (target.ready) return { id: target.id, photoPath: target.photoPath };

  let url: URL;
  try { url = new URL(target.presignedUrl); }
  catch { throw failure("Photo upload location is invalid", undefined, "INVALID_RESPONSE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw failure("Photo upload location is not secure", undefined, "INVALID_RESPONSE");
  }
  const expiresAt = Date.parse(target.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
    throw failure("Photo upload link expired. Retry the photo upload.", 410, "UPLOAD_EXPIRED");
  }
  const headers = new Headers(target.putHeaders);
  if (headers.get("content-type")?.toLowerCase() !== inspected.contentType) {
    throw failure("Photo upload type did not match the selected image", undefined, "INVALID_RESPONSE");
  }

  let putResponse: Response;
  try {
    putResponse = await fetcher(url, {
      method: "PUT",
      headers,
      body: file,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw failure("Photo transfer outcome is unclear. Retry saving the same photo.");
  }
  if (!putResponse.ok) {
    const error = failure(
      "Photo transfer failed. Retry saving the same photo.",
      putResponse.status === 401 || putResponse.status === 403 ? 502 : putResponse.status,
      "PHOTO_TRANSFER_FAILED",
    );
    error.storageStatus = putResponse.status;
    throw error;
  }

  const rawResult = await postJson("/_api/cellar/photo-finalize", { id: target.id }, requestOptions);
  const result = parseResult(rawResult, target.id);
  if (!result) throw failure("Uploaded photo could not be confirmed. Retry saving the same photo.", undefined, "INVALID_RESPONSE");
  return result;
}
