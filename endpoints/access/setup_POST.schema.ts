import { z } from "zod";
import superjson from "superjson";
import { User } from "../../helpers/User";

export const schema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128),
}).strict();

export type InputType = z.infer<typeof schema>;
export type OutputType = { user: User };

export const postSetup = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const result = await fetch("/_api/access/setup", {
    method: "POST",
    body: superjson.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const error = superjson.parse<{ message: string }>(await result.text());
    throw new Error(error.message || "Setup failed");
  }
  return superjson.parse<OutputType>(await result.text());
};
