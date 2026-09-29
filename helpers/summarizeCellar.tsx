type StockRow = {
  wineId: string;
  photoPath: string | null;
  quantity: number;
  fridge: string;
  shelf: string;
};

type ShelfSummary = { label: string; wineCount: number; bottleCount: number };
type FridgeAccumulator = {
  wines: Set<string>;
  bottleCount: number;
  shelves: Map<string, { wines: Set<string>; bottleCount: number }>;
};

export function summarizeCellar(rows: readonly StockRow[]) {
  const available = rows.filter((row) => Number.isFinite(row.quantity) && row.quantity > 0);
  const wines = new Set<string>();
  const photographedWines = new Set<string>();
  const fridges = new Map<string, FridgeAccumulator>();
  let bottleCount = 0;

  for (const row of available) {
    wines.add(row.wineId);
    if (row.photoPath) photographedWines.add(row.wineId);
    bottleCount += row.quantity;

    const fridgeName = row.fridge.trim() || "Unnamed fridge";
    const shelfLabel = row.shelf.trim() || "Unlabelled shelf";
    let fridge = fridges.get(fridgeName);
    if (!fridge) {
      fridge = { wines: new Set(), bottleCount: 0, shelves: new Map() };
      fridges.set(fridgeName, fridge);
    }
    fridge.wines.add(row.wineId);
    fridge.bottleCount += row.quantity;

    let shelf = fridge.shelves.get(shelfLabel);
    if (!shelf) {
      shelf = { wines: new Set(), bottleCount: 0 };
      fridge.shelves.set(shelfLabel, shelf);
    }
    shelf.wines.add(row.wineId);
    shelf.bottleCount += row.quantity;
  }

  const compareLabels = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const fridgeSummaries = [...fridges.entries()]
    .sort(([a], [b]) => compareLabels(a, b))
    .map(([name, fridge]) => ({
      name,
      wineCount: fridge.wines.size,
      bottleCount: fridge.bottleCount,
      shelves: [...fridge.shelves.entries()]
        .sort(([a], [b]) => compareLabels(a, b))
        .map(([label, shelf]): ShelfSummary => ({ label, wineCount: shelf.wines.size, bottleCount: shelf.bottleCount })),
    }));

  return {
    wineCount: wines.size,
    bottleCount,
    photoCount: photographedWines.size,
    fridges: fridgeSummaries,
  };
}
