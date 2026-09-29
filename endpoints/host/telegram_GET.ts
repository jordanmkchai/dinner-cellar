import { getTelegramStatus } from "../../helpers/telegramServer";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, false);
    if (principal.role !== "host") throw new Error("Host access required");
    return inventoryJson(await getTelegramStatus(principal));
  } catch (error) {
    return inventoryError(error);
  }
}
