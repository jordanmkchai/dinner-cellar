import superjson from "superjson";

export type OutputType = {
  role: "host" | "guest";
  wineCount: number;
  bottleCount: number;
  photoCount: number;
  fridges: Array<{
    name: string;
    wineCount: number;
    bottleCount: number;
    shelves: Array<{ label: string; wineCount: number; bottleCount: number }>;
  }>;
};

export async function getCellarSummary(init?: RequestInit): Promise<OutputType | null> {
  const response = await fetch("/_api/cellar/summary", { ...init, method: "GET", cache: "no-store" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Cellar summary unavailable");
  return superjson.parse<OutputType>(await response.text());
}
