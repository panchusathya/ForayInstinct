import { defineTool } from "eve/tools";
import { z } from "zod";
import { waitForEmailOtp } from "@/agent/lib/google-workspace/gmail";

const inputSchema = z.object({
  fromHint: z.string().min(1).max(200).optional(),
  subjectHint: z.string().min(1).max(200).optional(),
});

export default defineTool({
  description:
    'Wait for a recent email one-time code in the connected Gmail inbox after a runner { pause: "email_otp" } result. Pass any sender or subject hint from the fill run. Returns only a structured code plus From/Subject/Date, never the message body. If Gmail is disconnected or no code arrives, ask the candidate for the code and call continue_application with it. Do not print the code to the user. Do not use this for SMS OTP or 3-D Secure.',
  inputSchema,
  async execute(input, ctx) {
    return waitForEmailOtp(ctx, input);
  },
});
