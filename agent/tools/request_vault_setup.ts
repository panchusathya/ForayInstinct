import { defineTool } from "eve/tools";
import {
  createManagerSetupUrl,
  managerSetupRequestSchema,
} from "@/lib/manager";
import { env } from "@/lib/env";

export default defineTool({
  description:
    "Create a safe link for adding one supported item to the self-hosted vault. Supported kinds are login (email, phone, or username with a password or one-time-code method), payment (card details), address (structured delivery or billing address), and contact (name, email, and phone). A login setup requires a descriptive label, identifierType, and the exact current website origin. Optional passwordHint is the site's visible password rules. The vault can prefill only the signed-in candidate's verified email or phone; never put an identifier, password, or other secret in this setup request or URL. Other kinds accept only kind and an optional label.",
  inputSchema: managerSetupRequestSchema,
  execute(request) {
    return {
      message:
        "Send this as a markdown link the candidate can tap. The form is pre-filled; they only type the password. Do not ask for the password in chat.",
      url: createManagerSetupUrl(env.BETTER_AUTH_URL, request),
    };
  },
});
