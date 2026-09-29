import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  operationId: z.string().uuid(),
  sizeBytes: z.number().int().min(1).max(5 * 1024 * 1024),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();

export type InputType = z.infer<typeof schema>;
export type OutputType =
  | {
      ready: false;
      id: string;
      presignedUrl: string;
      putHeaders: { "Content-Type": InputType["contentType"] };
      expiresAt: string;
    }
  | { ready: true; id: string; photoPath: string };

type RequestError = Error & { status: number; code?: string; uncertain: boolean };

function errorPayload(text: string): { code?: string; message?: string } {
  let payload: unknown;
  try { payload = superjson.parse<unknown>(text); } catch {
    try { payload = JSON.parse(text) as unknown; } catch { return {}; }
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

function decodeOutput(text: string): OutputType | null {
  let value: unknown;
  try { value = superjson.parse<unknown>(text); } catch {
    try { value = JSON.parse(text) as unknown; } catch { return null; }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ready !== "boolean") return null;
  if (record.ready) {
    return typeof record.photoPath === "string" ? { ready: true, id: record.id, photoPath: record.photoPath } : null;
  }
  if (
    typeof record.presignedUrl !== "string" || typeof record.expiresAt !== "string" ||
    record.putHeaders === null || typeof record.putHeaders !== "object" || Array.isArray(record.putHeaders) ||
    typeof (record.putHeaders as Record<string, unknown>)["Content-Type"] !== "string"
  ) return null;
  const contentType = (record.putHeaders as Record<string, unknown>)["Content-Type"];
  if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") return null;
  return {
    ready: false,
    id: record.id,
    presignedUrl: record.presignedUrl,
    putHeaders: { "Content-Type": contentType },
    expiresAt: record.expiresAt,
  };
}

export async function postUploadWinePhoto(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse(body); } catch {
    throw Object.assign(new Error("Photo upload details are invalid"), {
      status: 400,
      code: "INVALID_INPUT",
      uncertain: false,
    }) satisfies RequestError;
  }

  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch("/_api/cellar/photo-upload", {
      ...init,
      method: "POST",
      credentials: "include",
      headers,
      body: superjson.stringify(parsed),
    });
  } catch {
    throw Object.assign(new Error("Photo upload reservation status is unknown. Retry with same operation ID."), {
      status: 0,
      code: "NETWORK_ERROR",
      uncertain: true,
    }) satisfies RequestError;
  }

  const text = await response.text();
  if (!response.ok) {
    const payload = errorPayload(text);
    throw Object.assign(new Error(payload.message || "Could not reserve photo upload"), {
      status: response.status,
      code: payload.code,
      uncertain: response.status >= 500,
    }) satisfies RequestError;
  }
  const output = decodeOutput(text);
  if (!output) {
    throw Object.assign(new Error("Photo upload reservation response is incomplete. Retry with same operation ID."), {
      status: response.status,
      code: "INVALID_RESPONSE",
      uncertain: true,
    }) satisfies RequestError;
  }
  return output;
}
