import { z } from "zod";
import superjson from "superjson";
import type { CheckoutReceipt } from "../../helpers/checkoutPolicy";

export const schema = z.object({ id: z.string().uuid() }).strict();
export type InputType = { id: string };
export type OutputType = CheckoutReceipt;

async function readErrorPayload(response: Response): Promise<{ message?: string; code?: string }> {
  let text = "";
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

export async function getCheckout(id: string, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse({ id }); } catch {
    const error = new Error("Checkout ID is invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const response = await fetch(`/_api/cellar/checkout?id=${encodeURIComponent(parsed.id)}`, {
    ...init,
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Checkout unavailable") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
