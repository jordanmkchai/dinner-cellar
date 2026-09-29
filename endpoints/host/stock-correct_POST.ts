import { sql } from "kysely";
import { schema } from "./stock-correct_POST.schema";
import { parseHostBody, planStockCorrection } from "../../helpers/hostInventoryPolicy";
import { PolicyError } from "../../helpers/inventoryPolicy";
import { inventoryError, inventoryJson, lockWine, readInventoryBody, requireInventoryAccess, withInventoryOperation } from "../../helpers/inventoryServer";

function normalizeReason(value: string): string {
  const note = value.trim();
  if (!note || note.length > 500) throw new PolicyError("Enter a reason of 1 to 500 characters", 400, "REASON_REQUIRED");
  return note;
}

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    const input = parseHostBody(schema, await readInventoryBody(request));
    const note = normalizeReason(input.note);
    const payload = { wineId: input.wineId, locationId: input.locationId, expectedVersion: input.expectedVersion, quantity: input.quantity, note };
    const result = await withInventoryOperation(principal, input.operationId, "host.stock.correct", payload, async (trx) => {
      await lockWine(trx, input.wineId);
      const stock = await trx
        .selectFrom("wineStock")
        .select(["quantity", "version"])
        .where("wineId", "=", input.wineId)
        .where("locationId", "=", input.locationId)
        .forUpdate()
        .executeTakeFirst();
      if (!stock) throw new PolicyError("Stock row not found", 404, "STOCK_ROW_NOT_FOUND");
      const plan = planStockCorrection({
        currentQuantity: stock.quantity,
        actualVersion: String(stock.version),
        expectedVersion: input.expectedVersion,
        quantity: input.quantity,
      });
      if (plan.changed) {
        await trx
          .updateTable("wineStock")
          .set({ quantity: plan.nextQuantity, version: sql`version + 1`, updatedAt: new Date() })
          .where("wineId", "=", input.wineId)
          .where("locationId", "=", input.locationId)
          .execute();
        await trx.insertInto("stockMovements").values({
          wineId: input.wineId,
          locationId: input.locationId,
          quantityDelta: plan.delta,
          kind: "adjustment",
          actorName: "Host",
          note,
        }).execute();
      }
      return { wineId: input.wineId };
    });
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
