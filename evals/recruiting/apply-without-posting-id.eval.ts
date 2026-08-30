import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Reproduces the production failure of 2026-08-30: asked for entry-level
 * corporate development roles, Foray answered out of `web_search`, so the
 * leads carried no posting id. Asked to apply, it refused twice — "i don't
 * have a valid posting id to submit against", then "i can't drive the
 * application form directly" — and offered to prepare text to paste instead.
 *
 * A role search must reach `find_goforay_roles`, and a chosen role must reach
 * the browser worker whether or not a posting id exists.
 */
const refusal =
  /i can'?t (drive|fill|submit|apply)|don'?t have a way to|paste (it|your resume) (in|into)/iu;

export default defineEval({
  description:
    "A role search routes to find_goforay_roles, and applying reaches the worker without a posting id.",
  tags: ["recruiting"],
  async test(t) {
    const search = await t.send(
      "Can you find me entry level corporate development jobs"
    );
    search.succeeded();
    // The candidate's own role search is never served by general web search:
    // those results carry no posting id and cannot be applied to.
    search.calledTool("find_goforay_roles");
    search.notCalledTool("web_search");

    const apply = await t.send("Let's apply to this one");
    apply.succeeded();
    // With or without a posting id, the fill is delegated to the browser
    // worker rather than handed back to the candidate as homework.
    apply.calledSubagent("worker", { count: 1 });
    t.check(
      t.reply,
      satisfies(
        (reply) => !refusal.test(String(reply)),
        "the reply does not refuse to drive the application form"
      )
    );
  },
});
