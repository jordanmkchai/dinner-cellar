import type { OutputType } from "./inventory-options_GET.schema";
import { db } from "../../helpers/db";
import { inventoryError, inventoryJson, requireInventoryAccess } from "../../helpers/inventoryServer";
import { wineCategoryFields } from "../../helpers/inventoryPolicy";
import { categoryFields, type CategoryKey } from "../../helpers/wineCatalog";

const fieldToKey = Object.fromEntries(
  Object.entries(wineCategoryFields).map(([key, fieldName]) => [fieldName, key]),
) as Record<string, CategoryKey>;

export async function handle(request: Request): Promise<Response> {
  try {
    await requireInventoryAccess(request);
    const [categoryRows, locations] = await Promise.all([
      db.selectFrom("categoryOptions").select(["fieldName", "value"]).orderBy("value").execute(),
      db.selectFrom("locations").select(["id", "fridge", "shelf"]).orderBy("fridge").orderBy("shelf").execute(),
    ]);
    const categories = Object.fromEntries(categoryFields.map(({ key }) => [key, [] as string[]])) as Record<CategoryKey, string[]>;
    for (const row of categoryRows) {
      const key = fieldToKey[row.fieldName];
      if (key && !categories[key].includes(row.value)) categories[key].push(row.value);
    }
    for (const key of categoryFields.map(({ key }) => key)) categories[key].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
    return inventoryJson({ categories, locations } satisfies OutputType);
  } catch (error) {
    return inventoryError(error);
  }
}
