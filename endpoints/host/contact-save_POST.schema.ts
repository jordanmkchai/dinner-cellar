import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  operationId: z.string().uuid(),
  id: z.string().uuid().optional(),
  expectedVersion: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  displayName: z.string().max(80),
  phoneE164: z.string().max(64),
  isHost: z.boolean(),
  active: z.boolean(),
}).strict().superRefine((input, context) => {
  if (input.id && !input.expectedVersion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedVersion"], message: "Expected version required for contact edits" });
  }
  if (!input.id && input.expectedVersion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedVersion"], message: "Expected version requires a contact id" });
  }
});
export type InputType = z.infer<typeof schema>;
export type OutputType = { contactId: string };

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

export async function postSaveContact(body: InputType, init?: RequestInit): Promise<OutputType> {
  let parsed: InputType;
  try { parsed = schema.parse(body); } catch {
    const error = new Error("Contact details are invalid") as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = "INVALID_INPUT";
    throw error;
  }
  const response = await fetch("/_api/host/contact-save", {
    method: "POST",
    body: superjson.stringify(parsed),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!response.ok) {
    const errorBody = await readErrorPayload(response);
    const error = new Error(errorBody.message || "Contact was not saved") as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = errorBody.code;
    throw error;
  }
  return superjson.parse<OutputType>(await response.text());
}
