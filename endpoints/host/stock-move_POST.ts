import { sql } from "kysely";
import { schema } from "./stock-move_POST.schema";
import { parseHostBody, planStockMove } from "../../helpers/hostInventoryPolicy";
import { assertVersion, normalizeLocation, PolicyError } from "../../helpers/inventoryPolicy";
import { ensureLocation, inventoryError, inventoryJson, lockWine, readInventoryBody, requireInventoryAccess, withInventoryOperation } from "../../helpers/inventoryServer";

function normalizeReason(value: string): string {
  const note = value.trim();
  if (!note || note.length > 500) throw new PolicyError("Enter a reason of 1 to 500 characters", 400, "REASON_REQUIRED");
  return note;
}

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    const input = parseHostBody(schema, await readInventoryBody(request));
    const fridge = normalizeLocation(input.fridge);
    const shelf = normalizeLocation(input.shelf);
    const note = normalizeReason(input.note);
    const payload = { wineId: input.wineId, fromLocationId: input.fromLocationId, expectedVersion: input.expectedVersion, fridge, shelf, quantity: input.quantity, note };
    const result = await withInventoryOperation(principal, input.operationId, "host.stock.move", payload, async (trx) => {
      await lockWine(trx, input.wineId);
      const source = await trx
        .selectFrom("wineStock")
        .select(["quantity", "version"])
        .where("wineId", "=", input.wineId)
        .where("locationId", "=", input.fromLocationId)
        .forUpdate()
        .executeTakeFirst();
      if (!source) throw new PolicyError("Source stock row not found", 404, "STOCK_ROW_NOT_FOUND");
      // Fail stale forms before creating or looking up the destination.
      assertVersion(String(source.version), input.expectedVersion);
      const targetLocationId = await ensureLocation(trx, fridge, shelf);
      const target = await trx
        .selectFrom("wineStock")
        .select(["quantity", "version"])
        .where("wineId", "=", input.wineId)
        .where("locationId", "=", targetLocationId)
        .forUpdate()
        .executeTakeFirst();
      const plan = planStockMove({
        sourceLocationId: input.fromLocationId,
        targetLocationId,
        actualVersion: String(source.version),
        expectedVersion: input.expectedVersion,
        sourceQuantity: source.quantity,
        targetQuantity: target?.quantity ?? 0,
        quantity: input.quantity,
      });
      const now = new Date();
      await trx
        .updateTable("wineStock")
        .set({ quantity: plan.sourceAfter, version: sql`version + 1`, updatedAt: now })
        .where("wineId", "=", input.wineId)
        .where("locationId", "=", input.fromLocationId)
        .execute();
      if (target) {
        await trx
          .updateTable("wineStock")
          .set({ quantity: plan.targetAfter, version: sql`version + 1`, updatedAt: now })
          .where("wineId", "=", input.wineId)
          .where("locationId", "=", targetLocationId)
          .execute();
      } else {
        await trx.insertInto("wineStock").values({
          wineId: input.wineId,
          locationId: targetLocationId,
          quantity: plan.targetAfter,
          updatedAt: now,
        }).execute();
      }
      await trx.insertInto("stockMovements").values([
        { wineId: input.wineId, locationId: input.fromLocationId, quantityDelta: -plan.moved, kind: "move_out", actorName: "Host", note },
        { wineId: input.wineId, locationId: targetLocationId, quantityDelta: plan.moved, kind: "move_in", actorName: "Host", note },
      ]).execute();
      return { wineId: input.wineId };
    });
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
