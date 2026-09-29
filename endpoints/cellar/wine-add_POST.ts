import { sql } from "kysely";
import {
  normalizeName,
  normalizeLocation,
  normalizeWineInput,
  normalizedWineIdentity,
  quantity as normalizeQuantity,
  PolicyError,
} from "../../helpers/inventoryPolicy";
import {
  ensureLocation,
  inventoryError,
  inventoryJson,
  lockWine,
  readInventoryBody,
  requireInventoryAccess,
  resolveWinePhoto,
  saveCategoryOptions,
  withInventoryOperation,
} from "../../helpers/inventoryServer";

type AddBody = {
  operationId: string;
  contributorName: string;
  wine: unknown;
  fridge: string;
  shelf: string;
  quantity: number;
  createSeparate: boolean;
};

function parseBody(value: unknown): AddBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("Invalid request body");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.operationId !== "string" || typeof body.contributorName !== "string" ||
      typeof body.fridge !== "string" || typeof body.shelf !== "string" ||
      typeof body.createSeparate !== "boolean") {
    throw new PolicyError("Invalid request body");
  }
  return {
    operationId: body.operationId,
    contributorName: body.contributorName,
    wine: body.wine,
    fridge: body.fridge,
    shelf: body.shelf,
    quantity: body.quantity as number,
    createSeparate: body.createSeparate,
  };
}

export async function handle(request: Request): Promise<Response> {
  try {
    const principal = await requireInventoryAccess(request, false, true);
    const raw = parseBody(await readInventoryBody(request));
    const contributorName = normalizeName(raw.contributorName);
    const wine = normalizeWineInput(raw.wine);
    const fridge = normalizeLocation(raw.fridge);
    const shelf = normalizeLocation(raw.shelf);
    if (typeof raw.quantity !== "number") throw new PolicyError("Quantity must be a positive whole number");
    const amount = normalizeQuantity(raw.quantity);

    const result = await withInventoryOperation(
      principal,
      raw.operationId,
      "wine-add",
      { contributorName, wine, fridge, shelf, quantity: amount, createSeparate: raw.createSeparate },
      async (trx) => {
        const identity = normalizedWineIdentity(wine);
        await sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`.execute(trx);

        const existing = await trx
          .selectFrom("wines")
          .select(["id", "producer", "wineName", "vintage", "bottleSizeMl"])
          .execute();
        const matchingWineIds = existing
          .filter((candidate) => normalizedWineIdentity({
            producer: candidate.producer,
            wineName: candidate.wineName,
            vintage: candidate.vintage,
            country: null,
            region: null,
            subregion: null,
            appellation: null,
            grapeBlend: null,
            colour: null,
            wineStyle: null,
            sweetness: null,
            bottleSizeMl: candidate.bottleSizeMl,
          }) === identity)
          .map((candidate) => candidate.id);
        if (matchingWineIds.length > 0 && !raw.createSeparate) {
          throw new PolicyError(
            "A wine with this producer, name, vintage, and bottle size already exists. Choose Add bottles or confirm a separate label.",
            409,
            "MATCHING_WINE",
          );
        }

        const photoPath = await resolveWinePhoto(trx, principal, wine.photoId, null);
        const values = {
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
        };
        const createdWine = await trx.insertInto("wines").values(values).returning("id").executeTakeFirstOrThrow();
        const wineId = createdWine.id;
        await lockWine(trx, wineId);
        const locationId = await ensureLocation(trx, fridge, shelf);
        await trx.insertInto("wineStock").values({ wineId, locationId, quantity: amount, version: 0 }).execute();
        await trx.insertInto("stockMovements").values({
          wineId,
          locationId,
          quantityDelta: amount,
          kind: "restock",
          actorName: contributorName,
          note: "Initial stock added with wine entry",
        }).execute();
        await saveCategoryOptions(trx, wine);
        return { wineId };
      },
    );
    return inventoryJson(result);
  } catch (error) {
    return inventoryError(error);
  }
}
