import { schema } from "./telegram-connect_POST.schema";
import { beginTelegramConnection } from "../../helpers/telegramServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    if (principal.role !== "host") throw new Error("Host access required");
    schema.parse(await readInventoryBody(request));
    return inventoryJson(await beginTelegramConnection(principal));
  } catch (error) {
    return inventoryError(error);
  }
}
