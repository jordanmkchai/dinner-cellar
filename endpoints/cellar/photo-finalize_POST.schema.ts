import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ id: z.string().uuid() }).strict();
export type InputType = z.infer<typeof schema>;
export type OutputType = { id: string; photoPath: string };

type RequestError = Error & { status: number; code?: string; uncertain: boolean };

function decode(value: string): unknown {
  try { return superjson.parse<unknown>(value); } catch {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  }
}

export async function postFinalizeWinePhoto(id: string, init?: RequestInit): Promise<OutputType> {
  let body: InputType;
  try { body = schema.parse({ id }); } catch {
    throw Object.assign(new Error("Photo upload ID is invalid"), {
      status: 400,
      code: "INVALID_INPUT",
      uncertain: false,
    }) satisfies RequestError;
  }

  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch("/_api/cellar/photo-finalize", {
      ...init,
      method: "POST",
      credentials: "include",
      headers,
      body: superjson.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("Photo finalize status is unknown. Retry finalize."), {
      status: 0,
      code: "NETWORK_ERROR",
      uncertain: true,
    }) satisfies RequestError;
  }

  let text: string;
  try { text = await response.text(); } catch {
    throw Object.assign(new Error("Photo finalize status is unknown. Retry finalize."), {
      status: response.status,
      code: "NETWORK_ERROR",
      uncertain: true,
    }) satisfies RequestError;
  }
  const payload = decode(text);
  if (!response.ok) {
    const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    throw Object.assign(new Error(typeof record.message === "string" ? record.message : "Could not finalize photo upload"), {
      status: response.status,
      code: typeof record.code === "string" ? record.code : undefined,
      uncertain: response.status >= 500,
    }) satisfies RequestError;
  }
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).id !== "string" ||
    typeof (payload as Record<string, unknown>).photoPath !== "string"
  ) {
    throw Object.assign(new Error("Photo finalize response is incomplete. Retry finalize."), {
      status: response.status,
      code: "INVALID_RESPONSE",
      uncertain: true,
    }) satisfies RequestError;
  }
  return payload as OutputType;
}
