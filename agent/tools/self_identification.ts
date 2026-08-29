import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  readSelfIdentification,
  saveSelfIdentification,
} from "@/db/services/self-identification";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  declinedSelfIdentificationFields,
  selfIdentificationSchema,
} from "@/lib/self-identification";

/**
 * The candidate's voluntary self-identification answers, saved once and reused
 * on every application. Without them the worker used to escalate mid-fill and
 * stall the application on a question the ATS never required.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        self_identification: defineTool({
          description:
            'Read or save the candidate\'s voluntary self-identification answers (gender, race/ethnicity, veteran status, disability status) used for ATS EEO sections. Use "get" before delegating an application so the worker can fill them, and "save" only with answers the candidate stated themselves. Never infer these from a name, and never block an application on them: any field left unset is declined on the form.',
          inputSchema: z.object({
            action: z.enum(["get", "save"]),
            answers: selfIdentificationSchema.optional(),
          }),
          async execute({ action, answers }) {
            const stored =
              action === "save"
                ? await saveSelfIdentification(scope, answers ?? {})
                : await readSelfIdentification(scope);
            return {
              answers: stored,
              declined: declinedSelfIdentificationFields(stored),
            };
          },
        }),
      };
    },
  },
});
