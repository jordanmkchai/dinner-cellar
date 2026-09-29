import { summarizeCellar } from "./summarizeCellar";

describe("summarizeCellar", () => {
  it("counts distinct wines and available bottles by fridge and shelf", () => {
    const result = summarizeCellar([
      { wineId: "wine-a", photoPath: "a.jpg", quantity: 2, fridge: "Main", shelf: "Shelf 1" },
      { wineId: "wine-a", photoPath: "a.jpg", quantity: 1, fridge: "Main", shelf: "Shelf 2" },
      { wineId: "wine-b", photoPath: null, quantity: 3, fridge: "Main", shelf: "Shelf 1" },
      { wineId: "wine-a", photoPath: "a.jpg", quantity: 1, fridge: "Dining", shelf: "1" },
      { wineId: "wine-c", photoPath: "c.jpg", quantity: 0, fridge: "Main", shelf: "Shelf 3" },
    ]);

    expect(result).toEqual({
      wineCount: 2,
      bottleCount: 7,
      photoCount: 1,
      fridges: [
        {
          name: "Dining",
          wineCount: 1,
          bottleCount: 1,
          shelves: [{ label: "1", wineCount: 1, bottleCount: 1 }],
        },
        {
          name: "Main",
          wineCount: 2,
          bottleCount: 6,
          shelves: [
            { label: "Shelf 1", wineCount: 2, bottleCount: 5 },
            { label: "Shelf 2", wineCount: 1, bottleCount: 1 },
          ],
        },
      ],
    });
  });

  it("returns an empty summary when no stock is available", () => {
    expect(summarizeCellar([])).toEqual({ wineCount: 0, bottleCount: 0, photoCount: 0, fridges: [] });
  });
});
