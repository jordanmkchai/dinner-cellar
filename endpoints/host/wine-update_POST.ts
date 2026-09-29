import { sql } from "kysely";
import { schema } from "./wine-update_POST.schema";
import { parseHostBody } from "../../helpers/hostInventoryPolicy";
import { inventoryError, inventoryJson, lockWine, readInventoryBody, requireInventoryAccess, resolveWinePhoto, saveCategoryOptions, withInventoryOperation } from "../../helpers/inventoryServer";
import { assertVersion, normalizeWineInput } from "../../helpers/inventoryPolicy";

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, true, true);
    const input = parseHostBody(schema, await readInventoryBody(request));
    const wine = normalizeWineInput(input.wine);
    const payload = { wineId: input.wineId, expectedVersion: input.expectedVersion, wine };
    const result = await withInventoryOperation(principal, input.operationId, "host.wine.update", payload, async (trx) => {
      await lockWine(trx, input.wineId);
      const current = await trx
        .selectFrom("wines")
        .select(["version", "photoPath"])
        .where("id", "=", input.wineId)
        .executeTakeFirstOrThrow();
      assertVersion(String(current.version), input.expectedVersion);
      const photoPath = await resolveWinePhoto(trx, principal, wine.photoId, current.photoPath);
      await trx
        .updateTable("wines")
        .set({
          producer: wine.producer,
          wineName: wine.wineName,
          vintage: wine.vintage,
          country: wine.country,
          region: wine.region,
          subregion: wine.subregion,
          appellation: wine.appellation,
          grapeBlend: wine.grapeBlend,
          colour: wine.colour,
          wineStyle: wine.wineStyle,
          sweetness: wine.sweetness,
          bottleSizeMl: wine.bottleSizeMl,
          photoPath,
          version: sql`version + 1`,
          updatedAt: new Date(),
        })
        .where("id", "=", input.wineId)
        .execute();
      await saveCategoryOptions(trx, wine);
      return { wineId: input.wineId };
    });
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
