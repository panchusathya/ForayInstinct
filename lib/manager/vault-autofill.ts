import { z } from "zod";

export const fillFromVaultRequestSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
  purpose: z.enum(["sign_in", "sign_up"]).default("sign_in"),
});
