import superjson from "superjson";
import type { CatalogWine } from "../../helpers/wineCatalog";

export type OutputType = {
  role: "host" | "guest";
  wines: CatalogWine[];
};

export async function getWineCatalog(init?: RequestInit): Promise<OutputType | null> {
  const response = await fetch("/_api/cellar/catalog", {
    ...init,
    method: "GET",
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Cellar catalog unavailable");
  return superjson.parse<OutputType>(await response.text());
}
