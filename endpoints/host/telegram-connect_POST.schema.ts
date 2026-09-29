import { z } from "zod";
export const schema = z.object({}).strict();
export type InputType = z.infer<typeof schema>;
