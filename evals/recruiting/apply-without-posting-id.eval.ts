import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Reproduces the production failure of 2026-08-30: asked for entry-level
 * corporate development roles, Foray answered out of `web_search`, so the
 * leads were reading, not JuiceBox cards. Asked to apply, it refused twice
 * and offered to prepare text to paste instead.
 *
 * A role search must reach `find_goforay_roles` (JuiceBox, which owns Exa),
 * and a chosen role must reach the browser worker against the apply URL.
 */
const refusal =
  /i can'?t (drive|fill|submit|apply)|don'?t have a way to|paste (it|your resume) (in|into)/iu;

export default defineEval({
  description:
    "A role search routes to find_goforay_roles, and applying reaches the worker against the URL.",
  tags: ["recruiting"],
  async test(t) {
    const search = await t.send(
      "Can you find me entry level corporate development jobs"
    );
    search.succeeded();
    search.calledTool("find_goforay_roles");
    search.notCalledTool("web_search");
    search.notCalledTool("start_goforay_application");

    const apply = await t.send("Let's apply to this one");
    apply.succeeded();
    apply.calledSubagent("worker", { count: 1 });
    apply.notCalledTool("start_goforay_application");
    apply.notCalledTool("report_goforay_application_result");
    t.check(
      t.reply,
      satisfies(
        (reply) => !refusal.test(String(reply)),
        "the reply does not refuse to drive the application form"
      )
    );
  },
});
