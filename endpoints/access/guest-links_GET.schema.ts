import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({});
export type OutputType = {
  links: Array<{
    id: string;
    createdAt: string;
    revokedAt: string | null;
    active: boolean;
  }>;
};

export const getGuestLinks = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch("/_api/access/guest-links", {
    method: "GET",
    ...init,
    credentials: "include",
  });
  if (!result.ok) {
    const error = superjson.parse<{ message: string }>(await result.text());
    throw new Error(error.message || "Could not load guest links");
  }
  return superjson.parse<OutputType>(await result.text());
};
