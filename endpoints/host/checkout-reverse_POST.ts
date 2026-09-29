import { dispatchTelegram } from "../../helpers/telegramServer";
import { schema } from "./checkout-reverse_POST.schema";
import { reverseCheckout } from "../../helpers/checkoutServer";
import { inventoryError, inventoryJson, readInventoryBody, requireInventoryAccess } from "../../helpers/inventoryServer";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    if (principal.role !== "host") throw new Error("Host-only endpoint returned guest access");
    const input = schema.parse(await readInventoryBody(request));
    const receipt = await reverseCheckout({ principal, ...input });
    try { await dispatchTelegram(receipt.id, "reversal", new URL(request.url).origin); }
    catch { console.error("Telegram delivery deferred; reversal remains saved"); }
    return inventoryJson(receipt);
  } catch (error) {
    return inventoryError(error);
  }
}
