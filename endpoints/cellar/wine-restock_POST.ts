import { sql } from "kysely";
import { normalizeName, normalizeLocation, quantity as normalizeQuantity, stockTotal, PolicyError } from "../../helpers/inventoryPolicy";
import {
  ensureLocation,
  inventoryError,
  inventoryJson,
  lockWine,
  readInventoryBody,
  requireInventoryAccess,
  withInventoryOperation,
} from "../../helpers/inventoryServer";
import { schema } from "./wine-restock_POST.schema";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    let body: ReturnType<typeof schema.parse>;
    try {
      body = schema.parse(await readInventoryBody(request));
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError("Invalid request body");
    }
    const contributorName = normalizeName(body.contributorName);
    const fridge = normalizeLocation(body.fridge);
    const shelf = normalizeLocation(body.shelf);
    const amount = normalizeQuantity(body.quantity);

    const result = await withInventoryOperation(
      principal,
      body.operationId,
      "wine-restock",
      { contributorName, wineId: body.wineId, fridge, shelf, quantity: amount },
      async (trx) => {
        await lockWine(trx, body.wineId);
        const locationId = await ensureLocation(trx, fridge, shelf);
        const current = await trx
          .selectFrom("wineStock")
          .select("quantity")
          .where("wineId", "=", body.wineId)
          .where("locationId", "=", locationId)
          .forUpdate()
          .executeTakeFirst();
        const nextQuantity = stockTotal(current?.quantity ?? 0, amount);
        if (!current) {
          await trx.insertInto("wineStock").values({
            wineId: body.wineId,
            locationId,
            quantity: nextQuantity,
            version: 0,
          }).execute();
        } else {
          await trx.updateTable("wineStock").set({
            quantity: nextQuantity,
            version: sql`version + 1`,
            updatedAt: new Date(),
          }).where("wineId", "=", body.wineId).where("locationId", "=", locationId).execute();
        }
        await trx.insertInto("stockMovements").values({
          wineId: body.wineId,
          locationId,
          quantityDelta: amount,
          kind: "restock",
          actorName: contributorName,
        }).execute();
        return { wineId: body.wineId };
      },
    );
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
