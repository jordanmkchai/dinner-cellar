export type CatalogRow = {
  id: string;
  producer: string;
  wineName: string;
  vintage: string | null;
  country: string | null;
  region: string | null;
  subregion: string | null;
  appellation: string | null;
  grapeBlend: string | null;
  colour: string | null;
  wineStyle: string | null;
  sweetness: string | null;
  bottleSizeMl: number;
  photoPath: string | null;
  locationId: string | null;
  fridge: string | null;
  shelf: string | null;
  quantity: number | null;
};

export type CatalogWine = {
  id: string;
  producer: string;
  wineName: string;
  vintage: string | null;
  country: string | null;
  region: string | null;
  subregion: string | null;
  appellation: string | null;
  grapeBlend: string | null;
  colour: string | null;
  wineStyle: string | null;
  sweetness: string | null;
  bottleSizeMl: number;
  photoPath: string | null;
  totalQuantity: number;
  locations: Array<{
    locationId: string;
    fridge: string;
    shelf: string;
    quantity: number;
  }>;
};

export const categoryFields = [
  { key: "producer", label: "Producer" },
  { key: "wineName", label: "Wine name" },
  { key: "vintage", label: "Vintage" },
  { key: "country", label: "Country" },
  { key: "region", label: "Region" },
  { key: "subregion", label: "Subregion" },
  { key: "appellation", label: "Appellation" },
  { key: "grapeBlend", label: "Grape / blend" },
  { key: "colour", label: "Colour" },
  { key: "wineStyle", label: "Wine style" },
  { key: "sweetness", label: "Sweetness" },
  { key: "bottleSizeMl", label: "Bottle size (ml)" },
] as const;

export type CategoryKey = (typeof categoryFields)[number]["key"];

export type CatalogFilters = {
  search: string;
  availableOnly: boolean;
  categories: Partial<Record<CategoryKey, string>>;
  fridge: string;
  shelf: string;
};

type CategoryValue = string | number | null;
type CategoryValues = Record<CategoryKey, (wine: CatalogWine) => CategoryValue>;

const categoryValues: CategoryValues = {
  producer: (wine) => wine.producer,
  wineName: (wine) => wine.wineName,
  vintage: (wine) => wine.vintage,
  country: (wine) => wine.country,
  region: (wine) => wine.region,
  subregion: (wine) => wine.subregion,
  appellation: (wine) => wine.appellation,
  grapeBlend: (wine) => wine.grapeBlend,
  colour: (wine) => wine.colour,
  wineStyle: (wine) => wine.wineStyle,
  sweetness: (wine) => wine.sweetness,
  bottleSizeMl: (wine) => wine.bottleSizeMl,
};

const compareLabels = (left: string, right: string): number =>
  left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });

const normalizeSearchText = (value: string): string =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");

const compareWines = (left: CatalogWine, right: CatalogWine): number =>
  compareLabels(left.producer, right.producer) ||
  compareLabels(left.wineName, right.wineName) ||
  compareLabels(left.vintage ?? "", right.vintage ?? "") ||
  left.id.localeCompare(right.id);

export function emptyCatalogFilters(): CatalogFilters {
  return { search: "", availableOnly: true, categories: {}, fridge: "", shelf: "" };
}

export function buildCatalog(rows: readonly CatalogRow[]): CatalogWine[] {
  type WineAccumulator = Omit<CatalogWine, "locations"> & {
    locationMap: Map<string, CatalogWine["locations"][number]>;
  };

  const wines = new Map<string, WineAccumulator>();
  for (const row of rows) {
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
        locationMap: new Map(),
      };
      wines.set(row.id, wine);
    }

    const quantity = row.quantity;
    if (
      row.locationId === null ||
      row.fridge === null ||
      row.shelf === null ||
      quantity === null ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      continue;
    }

    const existing = wine.locationMap.get(row.locationId);
    const locationQuantity = (existing?.quantity ?? 0) + quantity;
    wine.locationMap.set(row.locationId, {
      locationId: row.locationId,
      fridge: row.fridge,
      shelf: row.shelf,
      quantity: locationQuantity,
    });
  }

  return [...wines.values()]
    .map(({ locationMap, ...wine }) => {
      const locations = [...locationMap.values()].sort((left, right) =>
        compareLabels(left.fridge, right.fridge) ||
        compareLabels(left.shelf, right.shelf) ||
        left.locationId.localeCompare(right.locationId),
      );
      return {
        ...wine,
        totalQuantity: locations.reduce((total, location) => total + location.quantity, 0),
        locations,
      };
    })
    .sort(compareWines);
}

export function filterCatalog(
  wines: readonly CatalogWine[],
  filters: CatalogFilters,
): CatalogWine[] {
  const searchTokens = normalizeSearchText(filters.search.trim()).split(/\s+/u).filter(Boolean);

  return wines.filter((wine) => {
    if (filters.availableOnly && wine.totalQuantity <= 0) return false;

    const searchableText = normalizeSearchText(
      [wine.producer, wine.wineName, wine.grapeBlend ?? ""].join(" "),
    );
    if (searchTokens.some((token) => !searchableText.includes(token))) return false;

    for (const { key } of categoryFields) {
      const selectedValue = filters.categories[key];
      if (selectedValue === undefined || selectedValue === "") continue;
      const wineValue = categoryValues[key](wine);
      if (wineValue === null || String(wineValue) !== selectedValue) return false;
    }

    const fridge = filters.fridge;
    const shelf = filters.shelf;
    if (fridge || shelf) {
      const hasMatchingLocation = wine.locations.some(
        (location) =>
          (!fridge || location.fridge === fridge) &&
          (!shelf || location.shelf === shelf),
      );
      if (!hasMatchingLocation) return false;
    }

    return true;
  });
}

export function catalogOptions(
  wines: readonly CatalogWine[],
  filters: CatalogFilters,
): {
  categories: Record<CategoryKey, string[]>;
  fridges: string[];
  shelves: string[];
} {
  const categories = Object.fromEntries(
    categoryFields.map(({ key }) => {
      const values = new Set<string>();
      for (const wine of wines) {
        const value = categoryValues[key](wine);
        if (value !== null && String(value).trim() !== "") values.add(String(value));
      }
      return [key, [...values].sort(compareLabels)];
    }),
  ) as Record<CategoryKey, string[]>;

  const fridges = new Set<string>();
  const shelves = new Set<string>();
  for (const wine of wines) {
    for (const location of wine.locations) {
      fridges.add(location.fridge);
      if (!filters.fridge || location.fridge === filters.fridge) shelves.add(location.shelf);
    }
  }

  return {
    categories,
    fridges: [...fridges].sort(compareLabels),
    shelves: [...shelves].sort(compareLabels),
  };
}
