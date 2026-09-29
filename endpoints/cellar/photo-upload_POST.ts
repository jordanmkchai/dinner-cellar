import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";
import { PolicyError } from "../../helpers/inventoryPolicy";
import { reservePhotoUpload } from "../../helpers/photoUploadServer";
import { schema } from "./photo-upload_POST.schema";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    const value = await readInventoryBody(request);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sizeBytes = (value as Record<string, unknown>).sizeBytes;
      if (typeof sizeBytes === "number" && sizeBytes > MAX_PHOTO_BYTES) {
        throw new PolicyError("Photo file must be 5 MB or smaller", 413, "PHOTO_TOO_LARGE");
      }
    }
    const input = schema.parse(value);
    return inventoryJson(await reservePhotoUpload(principal, input));
  } catch (error) {
    return inventoryError(error);
  }
}
