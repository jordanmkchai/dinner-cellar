import type { CatalogWine } from "../../helpers/wineCatalog";
import { db } from "../../helpers/db";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";
import type { HostInventoryWine } from "./inventory_GET.schema";

type InventoryRow = Omit<CatalogWine, "locations" | "totalQuantity"> & {
  locationId: string | null;
  fridge: string | null;
  shelf: string | null;
  quantity: number | null;
  wineVersion: string | number | bigint;
  stockVersion: string | number | bigint | null;
};

export async function handle(request: Request): Promise<Response> {
  try {
    await requireInventoryAccess(request, true, false);
    const rows = await db
      .selectFrom("wines")
      .leftJoin("wineStock", "wineStock.wineId", "wines.id")
      .leftJoin("locations", "locations.id", "wineStock.locationId")
      .select([
        "wines.id as id",
        "wines.producer as producer",
        "wines.wineName as wineName",
        "wines.vintage as vintage",
        "wines.country as country",
        "wines.region as region",
        "wines.subregion as subregion",
        "wines.appellation as appellation",
        "wines.grapeBlend as grapeBlend",
        "wines.colour as colour",
        "wines.wineStyle as wineStyle",
        "wines.sweetness as sweetness",
        "wines.bottleSizeMl as bottleSizeMl",
        "wines.photoPath as photoPath",
        "wines.version as wineVersion",
        "locations.id as locationId",
        "locations.fridge as fridge",
        "locations.shelf as shelf",
        "wineStock.quantity as quantity",
        "wineStock.version as stockVersion",
      ])
      .orderBy("wines.producer")
      .orderBy("wines.wineName")
      .orderBy("wines.id")
      .orderBy("locations.fridge")
      .orderBy("locations.shelf")
      .orderBy("locations.id")
      .execute();

    const wines = new Map<string, HostInventoryWine>();
    for (const rawRow of rows) {
      const row = rawRow as InventoryRow;
      let wine = wines.get(row.id);
      if (!wine) {
        wine = {
          id: row.id,
          producer: row.producer,
          wineName: row.wineName,
          vintage: row.vintage,
          country: row.country,
          region: row.region,
          subregion: row.subregion,
          appellation: row.appellation,
          grapeBlend: row.grapeBlend,
          colour: row.colour,
          wineStyle: row.wineStyle,
          sweetness: row.sweetness,
          bottleSizeMl: row.bottleSizeMl,
          photoPath: row.photoPath,
          totalQuantity: 0,
          locations: [],
          version: String(row.wineVersion),
          stockRows: [],
        };
        wines.set(row.id, wine);
      }

      if (row.locationId === null || row.fridge === null || row.shelf === null || row.quantity === null) continue;
      const stockRow = {
        locationId: row.locationId,
        fridge: row.fridge,
        shelf: row.shelf,
        quantity: row.quantity,
        version: String(row.stockVersion),
      };
      wine.stockRows.push(stockRow);
      if (row.quantity > 0) {
        wine.locations.push(stockRow);
        wine.totalQuantity += row.quantity;
      }
    }

    return inventoryJson({ wines: [...wines.values()] });
  } catch (error) {
    return inventoryError(error);
  }
}
