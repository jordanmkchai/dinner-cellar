import { z } from "zod";
import superjson from "superjson";
import type { CheckoutSharePacket } from "../../helpers/pickupShareServer";

export const schema = z.object({ checkoutId: z.string().uuid() }).strict();
export type InputType = { checkoutId: string };
export type OutputType = CheckoutSharePacket;

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

export async function getCheckoutShare(checkoutId: string, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse({ checkoutId }); } catch {
    const error = new Error("Checkout ID is invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const response = await fetch(`/_api/host/checkout-share?checkoutId=${encodeURIComponent(parsed.checkoutId)}`, {
    ...init,
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    const body = await readErrorPayload(response);
    const error = new Error(body.message || "Checkout share packet unavailable") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
