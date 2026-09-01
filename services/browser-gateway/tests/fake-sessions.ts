import { sessionNotFound } from "../src/errors.ts";
import type { GatewaySessions } from "../src/registry.ts";

/**
 * A complete, honestly-typed GatewaySessions fake: every member exists, so
 * tests override only what they exercise instead of casting partials.
 */
export function fakeSessions(
  overrides: Partial<GatewaySessions> = {}
): GatewaySessions {
  const base: GatewaySessions = {
    cdp: () => Promise.resolve({}),
    cdpTargets: () =>
      Promise.resolve({
        iframes: [],
        page: { ref: "page-ref", url: "about:blank" },
      }),
    closeAll: () => Promise.resolve(),
    create: () => Promise.reject(new Error("fakeSessions.create unset")),
    delete: () => Promise.resolve({}),
    describe: (id) => {
      throw sessionNotFound(id);
    },
    list: () => [],
    runActions: () => Promise.resolve({}),
    runPlaywright: () => Promise.resolve({ success: true }),
    screenshot: () => Promise.resolve([]),
    size: 0,
    stageFile: (_id, path) => Promise.resolve(path),
    storageState: () => Promise.resolve({ cookies: [], origins: [] }),
  };
  return { ...base, ...overrides };
}
