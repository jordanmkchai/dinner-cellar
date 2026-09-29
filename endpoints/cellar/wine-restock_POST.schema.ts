import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  operationId: z.string().uuid(),
  contributorName: z.string(),
  wineId: z.string().uuid(),
  fridge: z.string(),
  shelf: z.string(),
  quantity: z.number().int(),
}).strict();

export type InputType = z.infer<typeof schema>;
export type OutputType = { wineId: string };

export async function postRestockWine(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsedBody: InputType;
  try {
    parsedBody = schema.parse(body);
  } catch {
    const error = new Error("Restock request is invalid") as Error & { status: number; code: string; uncertain: boolean };
    error.status = 400;
    error.code = "INVALID_INPUT";
    error.uncertain = false;
    throw error;
  }
  const result = await fetch("/_api/cellar/wine-restock", {
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
    const error = new Error(payload && "message" in payload && payload.message ? payload.message : "Could not add bottles") as Error & {
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
    const error = new Error("Restock response was incomplete") as Error & { status: number; uncertain: boolean };
    error.status = result.status;
    error.uncertain = true;
    throw error;
  }
  return payload as OutputType;
}
