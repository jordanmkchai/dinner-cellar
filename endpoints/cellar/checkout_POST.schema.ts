import { z } from "zod";
import superjson from "superjson";
import type { CheckoutDraft, CheckoutReceipt } from "../../helpers/checkoutPolicy";

const draftSchema = z.custom<CheckoutDraft>((value) => value !== undefined);
export const schema = z.object({
  operationId: z.string().uuid(),
  draft: draftSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export type InputType = { operationId: string; draft: CheckoutDraft; previewHash: string };
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

export async function postCheckout(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse(body); } catch {
    const error = new Error("Checkout details are invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const response = await fetch("/_api/cellar/checkout", {
    ...init,
    method: "POST",
    body: superjson.stringify(parsed),
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Checkout was not completed") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
