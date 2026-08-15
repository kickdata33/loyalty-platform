import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FINAL-ARCHITECTURE.md §22: Customer Portal business/UI components must never call `liff.*`
 * directly — everything goes through `LineClientProvider`/`useLineClient()`. This is a
 * source-scan test rather than a runtime mock check: the boundary §22 cares about is a *static*
 * property of the code ("no component imports/calls the LIFF SDK directly"), so scanning the
 * actual source files is the most direct and reliable way to assert it — a runtime test could
 * only prove the stub provider behaves correctly, not that some other component didn't also
 * reach around it and call `liff.*` itself.
 */

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return collectSourceFiles(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

const LIFF_CALL_PATTERN = /\bliff\s*\./;
const LIFF_IMPORT_PATTERN = /from\s+["']@line\/liff["']/;

/** Strips comments so doc comments that *mention* `liff.*` in prose (explaining the rule this
 * test enforces) don't trip the check — only actual code matters here. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function assertNoDirectLiffUsage(dir: string) {
  const files = collectSourceFiles(dir);
  expect(files.length).toBeGreaterThan(0); // sanity: the directory isn't empty/missing
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    expect(code, `${file} must not call liff.* directly`).not.toMatch(LIFF_CALL_PATTERN);
    expect(code, `${file} must not import @line/liff directly`).not.toMatch(LIFF_IMPORT_PATTERN);
  }
}

describe("LineClientProvider boundary (FINAL-ARCHITECTURE.md §22)", () => {
  it("src/app/m/** never calls liff.* directly", () => {
    assertNoDirectLiffUsage(path.resolve(import.meta.dirname, "../../src/app/m"));
  });

  it("src/components/customer-portal/** never calls liff.* directly", () => {
    assertNoDirectLiffUsage(path.resolve(import.meta.dirname, "../../src/components/customer-portal"));
  });

  it("no @line/liff dependency exists yet — LiffClientProvider is Phase 7, not Phase 2", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@line/liff"]).toBeUndefined();
    expect(pkg.devDependencies?.["@line/liff"]).toBeUndefined();
  });
});
