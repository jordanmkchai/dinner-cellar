import * as flootStorage from "@floot/storage";
import { PolicyError } from "./inventoryPolicy";
import { isSafePublicPhotoPath, type PhotoContentType } from "./photoUploadPolicy";

export type { PhotoContentType } from "./photoUploadPolicy";

export type WinePhotoStorageResult = {
  storageKey: string;
  photoPath: string;
  presignedUrl: string;
};

export function assertPublicPhotoPath(value: unknown): asserts value is string {
  if (!isSafePublicPhotoPath(value)) {
    throw new PolicyError("Photo storage returned an invalid public path", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }
}

export async function createWinePhotoUpload(input: {
  filename: string;
  contentType: PhotoContentType;
  sizeBytes: number;
}): Promise<WinePhotoStorageResult> {
  let result: Awaited<ReturnType<typeof flootStorage.upload>>;
  try {
    result = await flootStorage.upload({
      visibility: "public",
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
  } catch {
    throw new PolicyError("Photo storage is temporarily unavailable", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }
  if (!result.ok) {
    throw new PolicyError("Photo storage is temporarily unavailable", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }

  assertPublicPhotoPath(result.url);
  let signedUrl: URL;
  try {
    signedUrl = new URL(result.presignedUrl);
  } catch {
    throw new PolicyError("Photo storage returned an invalid upload URL", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }
  if (signedUrl.protocol !== "https:" || !signedUrl.hostname || signedUrl.username || signedUrl.password) {
    throw new PolicyError("Photo storage returned an invalid upload URL", 503, "PHOTO_STORAGE_UNAVAILABLE");
  }

  return {
    storageKey: input.filename,
    photoPath: result.url,
    presignedUrl: result.presignedUrl,
  };
}
