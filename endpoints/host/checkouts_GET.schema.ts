import { z } from "zod";
import superjson from "superjson";
import type { CheckoutReceipt } from "../../helpers/checkoutPolicy";

export const schema = z.object({}).strict();
export type InputType = Record<string, never>;
export type OutputType = { checkouts: CheckoutReceipt[]; limit: 100 };

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

export async function getHostCheckouts(init?: RequestInit): Promise<OutputType> {
  const response = await fetch("/_api/host/checkouts", {
    ...init,
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Checkout history unavailable") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
