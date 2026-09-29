import { schema } from "./telegram-retry_POST.schema";
import { retryTelegram } from "../../helpers/telegramServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    if (principal.role !== "host") throw new Error("Host access required");
    const input = schema.parse(await readInventoryBody(request));
    return inventoryJson(await retryTelegram(principal, new URL(request.url).origin, input.checkoutId, input.event, input.acknowledgePossibleDuplicate));
  } catch (error) {
    return inventoryError(error);
  }
}
