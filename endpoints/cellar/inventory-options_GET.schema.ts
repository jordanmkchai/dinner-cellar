import superjson from "superjson";
import { z } from "zod";
import type { CategoryKey } from "../../helpers/wineCatalog";

export const schema = z.object({});
export type OutputType = {
  categories: Record<CategoryKey, string[]>;
  locations: Array<{ id: string; fridge: string; shelf: string }>;
};

async function responseBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return superjson.parse<T>(text);
  } catch {
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }
}

async function errorPayload(response: Response): Promise<{ code?: string; message?: string }> {
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
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

export async function getInventoryOptions(init?: RequestInit): Promise<OutputType> {
  const response = await fetch("/_api/cellar/inventory-options", {
    ...init,
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await errorPayload(response);
    const error = new Error(body.message || "Could not load inventory options");
    Object.assign(error, { status: response.status, code: body.code });
    throw error;
  }
  return responseBody<OutputType>(response);
}
