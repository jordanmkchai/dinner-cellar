import type { CheckoutReceipt } from "./checkoutPolicy";
import { formatPickupItemMessage, safePickupPhotoUrl, wrapPickupText } from "./pickupSharePolicy";

export type PickupPhoto = { wineId: string; locationId: string; photoPath: string | null };
export type PickupSharePacket = { receipt: CheckoutReceipt; photos: PickupPhoto[]; preparedAt: string };

const CANVAS_WIDTH = 720;
const PHOTO_SIZE = 320;
const TEXT_START_Y = 430;
const TEXT_LINE_HEIGHT = 36;
const MAX_CANVAS_HEIGHT = 4096;
const MAX_CANVAS_PIXELS = 3_000_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_PICKUP_FILES = 100;
const MAX_SOURCE_IMAGE_PIXELS = 60_000_000;

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Preparing pickup images was cancelled");
  error.name = "AbortError";
  throw error;
}

function pickupKey(row: { wineId: string; locationId: string }): string {
  return JSON.stringify([row.wineId, row.locationId]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedItems(receipt: CheckoutReceipt): CheckoutReceipt["items"] {
  return [...receipt.items].sort((left, right) =>
    compareText(left.fridge, right.fridge) ||
    compareText(left.shelf, right.shelf) ||
    compareText(left.producer, right.producer) ||
    compareText(left.wineName, right.wineName) ||
    compareText(left.vintage ?? "", right.vintage ?? "") ||
    left.bottleSizeMl - right.bottleSizeMl ||
    compareText(left.wineId, right.wineId) ||
    compareText(left.locationId, right.locationId),
  );
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}

async function readBoundedImage(response: Response, path: string): Promise<Blob> {
  if (!response.ok) {
    const error = new Error("Could not load pickup photo (" + response.status + ")") as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  const declaredType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  if (!allowedTypes.has(declaredType)) throw new Error("Pickup photo is not a supported image: " + path);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_IMAGE_BYTES)) {
    throw new Error("Pickup photo exceeds 5 MB. Replace photo before sharing.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Pickup photo could not be read: " + path);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Pickup photo exceeds 5 MB. Replace photo before sharing.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("5 MB")) throw error;
    throw new Error("Pickup photo download failed: " + path);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (imageType(bytes) !== declaredType) throw new Error("Pickup photo content does not match its image type: " + path);
  return new Blob([bytes], { type: declaredType });
}

async function loadPhotoBitmap(photoPath: string, signal?: AbortSignal): Promise<ImageBitmap> {
  abortIfNeeded(signal);
  const origin = globalThis.location?.origin;
  if (!origin) throw new Error("Pickup photos can only be prepared in the cellar app");
  const url = safePickupPhotoUrl(photoPath, origin);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    if (signal?.aborted) abortIfNeeded(signal);
    throw new Error("Pickup photo download failed: " + photoPath);
  }
  const blob = await readBoundedImage(response, photoPath);
  abortIfNeeded(signal);
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot decode pickup photos");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: 640, resizeQuality: "high" });
  } catch {
    throw new Error("Pickup photo could not be decoded: " + photoPath);
  }
  if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > MAX_SOURCE_IMAGE_PIXELS) {
    bitmap.close();
    throw new Error("Pickup photo dimensions are too large. Replace photo before sharing.");
  }
  if (signal?.aborted) {
    bitmap.close();
    abortIfNeeded(signal);
  }
  return bitmap;
}

function canvasBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal?.aborted) {
        const error = new Error("Preparing pickup images was cancelled");
        error.name = "AbortError";
        reject(error);
      } else if (!blob) {
        reject(new Error("Pickup image could not be created. Try a smaller checkout."));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

function drawPhotoPlaceholder(context: CanvasRenderingContext2D): void {
  context.fillStyle = "#f0ece4";
  context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  context.strokeStyle = "#d4ccc0";
  context.lineWidth = 2;
  context.strokeRect(1, 1, PHOTO_SIZE - 2, PHOTO_SIZE - 2);
  context.fillStyle = "#6f695f";
  context.font = "600 24px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("Photo unavailable", PHOTO_SIZE / 2, PHOTO_SIZE / 2, PHOTO_SIZE - 30);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
}

function drawWinePhoto(context: CanvasRenderingContext2D, bitmap: ImageBitmap): void {
  context.fillStyle = "#f0ece4";
  context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  const scale = Math.min(PHOTO_SIZE / bitmap.width, PHOTO_SIZE / bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  context.drawImage(bitmap, Math.round((PHOTO_SIZE - width) / 2), Math.round((PHOTO_SIZE - height) / 2), width, height);
}

async function renderPickupFile(input: {
  receipt: CheckoutReceipt;
  item: CheckoutReceipt["items"][number];
  ordinal: number;
  itemCount: number;
  photoPath: string | null | undefined;
  preparedAt: string;
  signal?: AbortSignal;
}): Promise<File> {
  abortIfNeeded(input.signal);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot draw pickup images");
  let bitmap: ImageBitmap | null = null;

  try {
    if (input.photoPath) bitmap = await loadPhotoBitmap(input.photoPath, input.signal);
    abortIfNeeded(input.signal);
    canvas.width = CANVAS_WIDTH;
    canvas.height = 512;
    context.fillStyle = "#fbfaf6";
    context.fillRect(0, 0, CANVAS_WIDTH, canvas.height);
    context.fillStyle = "#814a3a";
    context.font = "700 17px system-ui, sans-serif";
    context.fillText("DINNER CELLAR · PICKUP", 44, 43);
    context.save();
    context.translate((CANVAS_WIDTH - PHOTO_SIZE) / 2, 72);
    if (bitmap) drawWinePhoto(context, bitmap);
    else drawPhotoPlaceholder(context);
    context.restore();

    context.fillStyle = "#302d28";
    context.font = "400 26px system-ui, sans-serif";
    const message = formatPickupItemMessage(input.receipt, input.item, input.ordinal, input.itemCount);
    const lines = wrapPickupText(message, (text) => context.measureText(text).width, CANVAS_WIDTH - 88);
    const prepared = "Prepared: " + input.preparedAt;
    const allLines = [prepared, "", ...lines];
    const requiredHeight = Math.max(512, TEXT_START_Y + allLines.length * TEXT_LINE_HEIGHT + 54);
    if (requiredHeight > MAX_CANVAS_HEIGHT || CANVAS_WIDTH * requiredHeight > MAX_CANVAS_PIXELS) {
      throw new Error("Pickup details are too long for one share image. Split this checkout before sharing.");
    }

    canvas.height = requiredHeight;
    context.fillStyle = "#fbfaf6";
    context.fillRect(0, 0, CANVAS_WIDTH, requiredHeight);
    context.fillStyle = "#814a3a";
    context.font = "700 17px system-ui, sans-serif";
    context.fillText("DINNER CELLAR · PICKUP", 44, 43);
    context.save();
    context.translate((CANVAS_WIDTH - PHOTO_SIZE) / 2, 72);
    if (bitmap) drawWinePhoto(context, bitmap);
    else drawPhotoPlaceholder(context);
    context.restore();

    context.fillStyle = "#827b72";
    context.font = "400 15px system-ui, sans-serif";
    context.fillText(prepared, 44, TEXT_START_Y - 14);
    context.fillStyle = "#302d28";
    context.font = "400 26px system-ui, sans-serif";
    context.textBaseline = "top";
    let y = TEXT_START_Y;
    for (const line of lines) {
      abortIfNeeded(input.signal);
      if (line.length > 0) context.fillText(line, 44, y, CANVAS_WIDTH - 88);
      y += TEXT_LINE_HEIGHT;
    }
    context.textBaseline = "alphabetic";

    const blob = await canvasBlob(canvas, input.signal);
    if (blob.type !== "image/png") throw new Error("Pickup image export did not produce PNG");
    if (blob.size > MAX_FILE_BYTES) throw new Error("Pickup image exceeds 5 MB. Split checkout before sharing.");
    return new File([blob], "pickup-" + String(input.ordinal).padStart(2, "0") + ".png", {
      type: "image/png",
      lastModified: Date.parse(input.preparedAt),
    });
  } finally {
    bitmap?.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function preparePickupFiles(packet: PickupSharePacket, signal?: AbortSignal): Promise<File[]> {
  abortIfNeeded(signal);
  if (!packet || typeof packet !== "object" || !packet.receipt) throw new Error("Checkout receipt is required");
  if (packet.receipt.status !== "completed") throw new Error("Reversed checkout cannot be shared for pickup. DO NOT PICK UP.");
  if (!Array.isArray(packet.photos)) throw new Error("Pickup photo list is invalid");
  const preparedTimestamp = Date.parse(packet.preparedAt);
  if (typeof packet.preparedAt !== "string" || !Number.isFinite(preparedTimestamp)) throw new Error("Pickup packet prepared time is invalid");
  if (typeof document === "undefined" || typeof File === "undefined") throw new Error("Pickup image sharing requires a supported browser");

  const items = orderedItems(packet.receipt);
  if (items.length === 0) throw new Error("Checkout has no pickup items");
  if (items.length > MAX_PICKUP_FILES) {
    throw new Error("This checkout has " + items.length + " pickup rows. Split it into " + MAX_PICKUP_FILES + " or fewer rows before sharing.");
  }
  const photos = new Map<string, string | null>();
  for (const photo of packet.photos) {
    if (
      !photo || typeof photo.wineId !== "string" || typeof photo.locationId !== "string" ||
      (photo.photoPath !== null && typeof photo.photoPath !== "string")
    ) throw new Error("Pickup photo list is invalid");
    const key = pickupKey(photo);
    if (photos.has(key)) throw new Error("Pickup photo list contains duplicate wine and location rows");
    photos.set(key, photo.photoPath);
  }

  const receiptKeys = new Set(items.map(pickupKey));
  for (const key of receiptKeys) {
    if (!photos.has(key)) throw new Error("Pickup photo mapping is missing a wine and location row");
  }
  if ([...photos.keys()].some((key) => !receiptKeys.has(key))) {
    throw new Error("Pickup photo list contains a row outside this checkout");
  }

  const preparedAt = new Date(preparedTimestamp).toISOString();
  const files: File[] = [];
  let totalBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    abortIfNeeded(signal);
    const item = items[index];
    const file = await renderPickupFile({
      receipt: packet.receipt,
      item,
      ordinal: index + 1,
      itemCount: items.length,
      photoPath: photos.get(pickupKey(item)),
      preparedAt,
      signal,
    });
    totalBytes += file.size;
    if (totalBytes > MAX_BATCH_BYTES) throw new Error("Pickup images exceed 50 MB total. Split this checkout before sharing.");
    files.push(file);
  }
  abortIfNeeded(signal);
  return files;
}
