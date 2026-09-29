import { schema } from "./checkout-preview_POST.schema";
import { createCheckoutPreview } from "../../helpers/checkoutServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    const input = schema.parse(await readInventoryBody(request));
    return inventoryJson(await createCheckoutPreview(principal, input.draft));
  } catch (error) {
    return inventoryError(error);
  }
}
