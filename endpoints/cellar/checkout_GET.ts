import { schema } from "./checkout_GET.schema";
import { getCheckoutReceipt } from "../../helpers/checkoutServer";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request);
    const input = schema.parse({ id: new URL(request.url).searchParams.get("id") });
    return inventoryJson(await getCheckoutReceipt(principal, input.id));
  } catch (error) {
    return inventoryError(error);
  }
}
