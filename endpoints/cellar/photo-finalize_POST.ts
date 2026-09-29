import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";
import { finalizePhotoUpload } from "../../helpers/photoUploadServer";
import { schema } from "./photo-finalize_POST.schema";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    const input = schema.parse(await readInventoryBody(request));
    return inventoryJson(await finalizePhotoUpload(request, principal, input.id));
  } catch (error) {
    return inventoryError(error);
  }
}
