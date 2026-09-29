import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  operationId: z.string().uuid(),
  wineId: z.string().uuid(),
  locationId: z.string().uuid(),
  expectedVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
  quantity: z.number().int().min(0).max(2147483647),
  note: z.string().max(500),
}).strict();
export type InputType = z.infer<typeof schema>;
export type OutputType = { wineId: string };

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

export async function postCorrectStock(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse(body); } catch {
    const error = new Error("Stock correction details are invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const response = await fetch("/_api/host/stock-correct", {
    method: "POST",
    body: superjson.stringify(parsed),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Stock count was not saved") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
