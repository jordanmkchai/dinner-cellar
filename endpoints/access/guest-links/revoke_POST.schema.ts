import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ id: z.string().uuid() }).strict();
export type InputType = z.infer<typeof schema>;
export type OutputType = { success: boolean };

export const postRevokeGuestLink = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const result = await fetch("/_api/access/guest-links/revoke", {
    method: "POST",
    body: superjson.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const error = superjson.parse<{ message: string }>(await result.text());
    throw new Error(error.message || "Could not revoke guest link");
  }
  return superjson.parse<OutputType>(await result.text());
};
