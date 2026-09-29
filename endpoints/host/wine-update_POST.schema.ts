import { z } from "zod";
import superjson from "superjson";
import type { WineInput } from "../../helpers/inventoryPolicy";

const text = z.string().max(300);
const optionalText = z.string().max(300).nullable();
export const wineInputSchema = z.object({
  producer: text,
  wineName: text,
  vintage: optionalText,
  country: optionalText,
  region: optionalText,
  subregion: optionalText,
  appellation: optionalText,
  grapeBlend: optionalText,
  colour: optionalText,
  wineStyle: optionalText,
  sweetness: optionalText,
  bottleSizeMl: z.number().int().min(1).max(2147483647),
  photoId: z.string().uuid().nullable().optional(),
}).strict();

export const schema = z.object({
  operationId: z.string().uuid(),
  wineId: z.string().uuid(),
  expectedVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
  wine: wineInputSchema,
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

export async function postUpdateWine(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse(body); } catch {
    const error = new Error("Wine details are invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const response = await fetch("/_api/host/wine-update", {
    method: "POST",
    body: superjson.stringify(parsed),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Wine details were not saved") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}

export type WineInputType = WineInput;
