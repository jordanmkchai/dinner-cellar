import { dispatchTelegram } from "../../helpers/telegramServer";
import { schema } from "./checkout_POST.schema";
import { commitCheckout } from "../../helpers/checkoutServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    const input = schema.parse(await readInventoryBody(request));
    const receipt = await commitCheckout({ principal, ...input });
    try { await dispatchTelegram(receipt.id, "checkout", new URL(request.url).origin); }
    catch { console.error("Telegram delivery deferred; checkout remains saved"); }
    return inventoryJson(receipt);
  } catch (error) {
    return inventoryError(error);
  }
}
