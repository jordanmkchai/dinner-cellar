import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type InputType = z.infer<typeof schema>;
export type OutputType = { role: "guest" };

export const postExchangeGuestLink = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const result = await fetch("/_api/access/guest/exchange", {
    method: "POST",
    body: superjson.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const error = superjson.parse<{ message: string }>(await result.text());
    throw new Error(error.message || "Guest link is invalid or expired");
  }
  return superjson.parse<OutputType>(await result.text());
};
