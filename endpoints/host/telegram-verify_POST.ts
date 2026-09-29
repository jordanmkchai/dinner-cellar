import { schema } from "./telegram-verify_POST.schema";
import { verifyTelegramConnection } from "../../helpers/telegramServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    if (principal.role !== "host") throw new Error("Host access required");
    schema.parse(await readInventoryBody(request));
    return inventoryJson(await verifyTelegramConnection(principal));
  } catch (error) {
    return inventoryError(error);
  }
}
