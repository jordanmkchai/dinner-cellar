import superjson from "superjson";
import type { CatalogWine } from "../../helpers/wineCatalog";

export type HostStockRow = {
  locationId: string;
  fridge: string;
  shelf: string;
  quantity: number;
  version: string;
};

export type HostInventoryWine = CatalogWine & {
  version: string;
  stockRows: HostStockRow[];
};

export type OutputType = { wines: HostInventoryWine[] };

async function readErrorPayload(response: Response): Promise<{ message?: string; code?: string }> {
  let text: string;
  try { text = await response.text(); } catch { return {}; }
  let payload: unknown;
  try { payload = superjson.parse<unknown>(text); } catch {
    try { payload = JSON.parse(text) as unknown; } catch { return {}; }
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    try { payload = JSON.parse(text) as unknown; } catch { return {}; }
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

export async function getHostInventory(init?: RequestInit): Promise<OutputType> {
  const response = await fetch("/_api/host/inventory", {
    ...init,
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    const body = await readErrorPayload(response);
    const error = new Error(body.message || "Host inventory unavailable") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
