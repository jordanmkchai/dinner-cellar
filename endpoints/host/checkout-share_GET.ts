import { schema } from "./checkout-share_GET.schema";
import { getCheckoutSharePacket } from "../../helpers/pickupShareServer";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, false);
    if (principal.role !== "host") throw new Error("Host-only endpoint returned guest access");
    const checkoutId = new URL(request.url).searchParams.get("checkoutId");
    const input = schema.parse({ checkoutId });
    return inventoryJson(await getCheckoutSharePacket(principal, input.checkoutId));
  } catch (error) {
    return inventoryError(error);
  }
}
