import { getHostCheckouts } from "../../helpers/checkoutServer";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    await requireInventoryAccess(request, true, false);
    return inventoryJson(await getHostCheckouts());
  } catch (error) {
    return inventoryError(error);
  }
}
