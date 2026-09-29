import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({}).strict();
export type InputType = z.infer<typeof schema>;
export type OutputType = { link: { id: string; path: string } };

export const postCreateGuestLink = async (body: InputType = {}, init?: RequestInit): Promise<OutputType> => {
  const result = await fetch("/_api/access/guest-links/create", {
    method: "POST",
    body: superjson.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const error = superjson.parse<{ message: string }>(await result.text());
    throw new Error(error.message || "Could not create guest link");
  }
  return superjson.parse<OutputType>(await result.text());
};
