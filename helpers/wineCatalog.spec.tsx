import {
  buildCatalog,
  catalogOptions,
  emptyCatalogFilters,
  filterCatalog,
  type CatalogRow,
} from "./wineCatalog";

const row = (overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  id: "wine-a",
  producer: "Château Lumière",
  wineName: "Pinot Noir Réserve",
  vintage: "2019",
  country: "France",
  region: "Burgundy",
  subregion: null,
  appellation: "Côte de Nuits",
  grapeBlend: "Pinot Noir",
  colour: "Red",
  wineStyle: "Still",
  sweetness: "Dry",
  bottleSizeMl: 750,
  photoPath: "wine-a.jpg",
  locationId: "loc-main-1",
  fridge: "Main",
  shelf: "Shelf 1",
  quantity: 2,
  ...overrides,
});

describe("wineCatalog", () => {
  it("keeps zero-stock labels while summing only positive location stock", () => {
    const wines = buildCatalog([
      row(),
      row({ locationId: "loc-main-2", shelf: "Shelf 2", quantity: 3 }),
      row({ id: "wine-empty", producer: "Maison Vide", wineName: "Empty Cellar", photoPath: null, locationId: null, fridge: null, shelf: null, quantity: null }),
      row({ id: "wine-a", locationId: "loc-zero", quantity: 0 }),
      row({ id: "wine-a", locationId: "loc-negative", quantity: -1 }),
    ]);

    expect(wines.find((wine) => wine.id === "wine-a")?.totalQuantity).toBe(5);
    expect(wines.find((wine) => wine.id === "wine-a")?.locations.length).toBe(2);
    expect(wines.find((wine) => wine.id === "wine-empty")?.locations).toEqual([]);
  });

  it("searches across producer, wine, and grapes without accent sensitivity", () => {
    const wines = buildCatalog([row()]);
    expect(filterCatalog(wines, { ...emptyCatalogFilters(), search: "chateau réserve pinot" }).length).toBe(1);
  });

  it("requires fridge and shelf on the same location but keeps total quantity", () => {
    const wines = buildCatalog([
      row({ id: "wine-split", producer: "Cellar Mix", wineName: "Split label", grapeBlend: "Other grapes", locationId: "main", fridge: "Main", shelf: "Shelf 1", quantity: 1 }),
      row({ id: "wine-split", producer: "Cellar Mix", wineName: "Split label", grapeBlend: "Other grapes", locationId: "dining", fridge: "Dining", shelf: "A", quantity: 2 }),
    ]);
    expect(filterCatalog(wines, { ...emptyCatalogFilters(), fridge: "Main", shelf: "A" })).toEqual([]);
    const selected = filterCatalog(wines, { ...emptyCatalogFilters(), fridge: "Dining", shelf: "A" });
    expect(selected[0].totalQuantity).toBe(3);
  });

  it("defaults to available labels and constrains shelves by fridge", () => {
    const wines = buildCatalog([
      row(),
      row({ id: "wine-empty", producer: "Maison Vide", wineName: "Empty Cellar", locationId: null, fridge: null, shelf: null, quantity: null }),
      row({ id: "wine-b", producer: "Bodega Sol", wineName: "Tempranillo", locationId: "dining", fridge: "Dining", shelf: "A", quantity: 1 }),
    ]);
    expect(filterCatalog(wines, emptyCatalogFilters()).map((wine) => wine.id)).toEqual(["wine-b", "wine-a"]);
    expect(catalogOptions(wines, { ...emptyCatalogFilters(), fridge: "Dining" }).shelves).toEqual(["A"]);
    expect(catalogOptions(wines, emptyCatalogFilters()).categories.producer).toContain("Maison Vide");
  });
});
