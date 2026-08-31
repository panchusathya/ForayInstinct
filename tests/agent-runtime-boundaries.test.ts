import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/gu;
/** Renderers that only resolve inside the Next.js app. */
const NEXT_ONLY_RE = /^next\/og$|@vercel\/og/u;

/**
 * Eve compiles `agent/` into its own Nitro bundle: a lambda with no
 * `node_modules` and no `@vercel/og` wasm beside it. Anything reaching
 * `next/og` from there throws at runtime, and the job-card path catches that
 * and posts a text twin, so no unit test sees a failure — which is how two
 * releases shipped text on iMessage while everyone believed images were going
 * out. Only walking the real import graph catches it, and it has to be the
 * whole graph: the regression arrived through a helper module, not through the
 * channel itself.
 */
describe("agent runtime boundaries", () => {
  it("cannot reach a Next.js-only renderer from the Linq channel", async () => {
    const graph = await reachableFrom("agent/channels/linq-v2.ts");

    expect(graph.modules.size).toBeGreaterThan(10);
    expect(graph.offenders).toEqual([]);
    expect([...graph.modules]).not.toContain("lib/goforay/card-png.tsx");
  });
});

async function resolveModule(spec: string, importer: string) {
  const base = spec.startsWith("@/")
    ? resolve(REPO_ROOT, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(REPO_ROOT, dirname(importer), spec)
      : undefined;
  if (!base) return undefined;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    try {
      return { path: candidate, source: await readFile(candidate, "utf8") };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function reachableFrom(entry: string) {
  const modules = new Set<string>();
  const offenders: string[] = [];
  const pending = [entry];

  while (pending.length) {
    const current = pending.pop();
    if (current === undefined || modules.has(current)) continue;
    modules.add(current);

    const source = await readFile(resolve(REPO_ROOT, current), "utf8");
    for (const [, spec] of source.matchAll(IMPORT_RE)) {
      if (spec !== undefined && NEXT_ONLY_RE.test(spec)) {
        offenders.push(`${current} imports ${spec}`);
      }
      const resolved = spec ? await resolveModule(spec, current) : undefined;
      if (!resolved) continue;
      const relative = resolved.path.slice(REPO_ROOT.length + 1);
      if (!modules.has(relative)) pending.push(relative);
    }
  }
  return { modules, offenders };
}
