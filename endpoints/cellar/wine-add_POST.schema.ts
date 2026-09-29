import { z } from "zod";
import superjson from "superjson";
import type { WineInput } from "../../helpers/inventoryPolicy";

const wineSchema = z.object({
  producer: z.string(),
  wineName: z.string(),
  vintage: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  subregion: z.string().nullable(),
  appellation: z.string().nullable(),
  grapeBlend: z.string().nullable(),
  colour: z.string().nullable(),
  wineStyle: z.string().nullable(),
  sweetness: z.string().nullable(),
  bottleSizeMl: z.number().int(),
  photoId: z.string().uuid().nullable().optional(),
}).strict();

export const schema = z.object({
  operationId: z.string().uuid(),
  contributorName: z.string(),
  wine: wineSchema,
  fridge: z.string(),
  shelf: z.string(),
  quantity: z.number().int(),
  createSeparate: z.boolean(),
}).strict();

export type InputType = z.infer<typeof schema>;
export type OutputType = { wineId: string };

export async function postAddWine(body: {
  operationId: string;
  contributorName: string;
  wine: WineInput;
  fridge: string;
  shelf: string;
  quantity: number;
  createSeparate: boolean;
}, init?: RequestInit): Promise<OutputType> {
  let parsedBody: InputType;
  try {
    parsedBody = schema.parse(body);
  } catch {
    const error = new Error("Wine entry request is invalid") as Error & { status: number; code: string; uncertain: boolean };
    error.status = 400;
    error.code = "INVALID_INPUT";
    error.uncertain = false;
    throw error;
  }
  const result = await fetch("/_api/cellar/wine-add", {
    ...init,
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: superjson.stringify(parsedBody),
  });
  let payload: OutputType | { code?: string; message?: string } | null = null;
  try {
    payload = superjson.parse<OutputType | { code?: string; message?: string }>(await result.text());
  } catch {
    payload = null;
  }
  if (!result.ok) {
    const error = new Error(payload && "message" in payload && payload.message ? payload.message : "Could not add wine") as Error & {
      status: number;
      code?: string;
      uncertain: boolean;
    };
    error.status = result.status;
    error.code = payload && "code" in payload ? payload.code : undefined;
    error.uncertain = result.status >= 500;
    throw error;
  }
  if (!payload || !("wineId" in payload) || typeof payload.wineId !== "string") {
    const error = new Error("Add wine response was incomplete") as Error & { status: number; uncertain: boolean };
    error.status = result.status;
    error.uncertain = true;
    throw error;
  }
  return payload as OutputType;
}
