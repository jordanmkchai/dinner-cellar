import { z } from "zod";
export const schema = z.object({ checkoutId: z.string().uuid(), event: z.enum(["checkout", "reversal"]), acknowledgePossibleDuplicate: z.boolean().default(false) }).strict();
export type InputType = z.infer<typeof schema>;
