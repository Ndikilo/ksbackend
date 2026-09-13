#!/usr/bin/env bun
/**
 * Structural checks that oxlint cannot express, run in `bun run check` and CI:
 *
 *   1. File-naming patterns per area (see docs/conventions.md → "Naming & files"):
 *      - test/api/**            → `*.api.test.ts`
 *      - test/integration/**    → `*.integration.test.ts`
 *      - src/modules/<feature>/ → `<feature>.<role>[.test].ts`,
 *        role ∈ {routes, service, repo, policy, contract}. A module may nest
 *        sub-feature folders (e.g. practitioner/search/search.repo.ts): a file's
 *        required prefix is the name of the folder it lives in.
 *
 *   2. Import-boundary rules (see docs/architecture.md → "Layers"):
 *      dependencies point inward only — `domain ← modules ← http`, over shared
 *      `infra`; `lib` and `db` are leaves. Violations FAIL the build.
 */
import { Glob } from "bun";
import * as path from "node:path";

const ROLES = ["routes", "service", "repo", "policy", "contract"] as const;
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const isRole = (s: string | undefined): boolean => ROLE_SET.has(s ?? "");

const errors: string[] = [];
const fail = (file: string, message: string): void => {
  errors.push(`  ${file}\n    → ${message}`);
};

const scan = (pattern: string): string[] =>
  [...new Glob(pattern).scanSync(".")].map((p) => p.replaceAll("\\", "/"));

const files = [...scan("src/**/*.ts"), ...scan("test/**/*.ts")].toSorted();

// ---------------------------------------------------------------------------
// 1. File-naming patterns
// ---------------------------------------------------------------------------
for (const file of files) {
  const parts = file.split("/");
  const name = parts.at(-1) ?? file;

  if (file.startsWith("test/api/") && !name.endsWith(".api.test.ts")) {
    fail(file, "API test files must be named `*.api.test.ts`");
  }

  if (file.startsWith("test/integration/") && !name.endsWith(".integration.test.ts")) {
    fail(file, "integration test files must be named `*.integration.test.ts`");
  }

  if (file.startsWith("src/modules/")) {
    // A module file's feature prefix is the name of the folder it lives in, so a
    // module may nest sub-feature folders (e.g. practitioner/search/search.repo.ts).
    const feature = parts.at(-2);
    if (feature === undefined) continue;

    let core = name.slice(0, -".ts".length);
    if (core.endsWith(".test")) core = core.slice(0, -".test".length);
    const segments = core.split(".");

    if (segments[0] !== feature) {
      fail(file, `must start with its folder name "${feature}." (got "${segments[0] ?? ""}")`);
    } else if (!isRole(segments[1])) {
      fail(file, `role must be one of: ${ROLES.join(", ")} (e.g. ${feature}.service.ts)`);
    } else if (segments.length > 2) {
      fail(file, "too many name segments; expected `<feature>.<role>[.test].ts`");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Import boundaries
// ---------------------------------------------------------------------------
type Area = "lib" | "domain" | "db" | "infra" | "modules" | "free";

const areaOf = (file: string): Area => {
  if (file.startsWith("src/lib/")) return "lib";
  if (file.startsWith("src/domain/")) return "domain";
  if (file.startsWith("src/db/")) return "db";
  if (file.startsWith("src/infra/")) return "infra";
  if (file.startsWith("src/modules/")) return "modules";
  return "free"; // src/http, top-level src files, test/, scripts/
};

/** Resolve an import specifier to a repo-relative path ("" for packages). */
const resolveInternal = (file: string, spec: string): string => {
  if (spec.startsWith("@/")) return `src/${spec.slice("@/".length)}`;
  if (!spec.startsWith(".")) return "";
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
};

const packageOf = (spec: string): string => {
  if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("node:")) return "";
  const segments = spec.split("/");
  return spec.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? spec);
};

const importsOf = async (file: string): Promise<ReadonlyArray<string>> => {
  const content = await Bun.file(file).text();
  const specs = new Set<string>();
  for (const match of content.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g)) {
    if (match[1]) specs.add(match[1]);
  }
  for (const match of content.matchAll(/import\s*["']([^"']+)["']/g)) {
    if (match[1]) specs.add(match[1]);
  }
  return [...specs];
};

// Routes/contract files are the module's HTTP surface — they alone may touch
// the http helpers and hono packages.
const isHttpSurface = (file: string): boolean =>
  file.endsWith(".routes.ts") || file.endsWith(".contract.ts");

const boundedFiles = files.filter((file) => areaOf(file) !== "free");
const importsByFile = await Promise.all(boundedFiles.map(importsOf));

for (const [index, file] of boundedFiles.entries()) {
  const area = areaOf(file);

  for (const spec of importsByFile[index] ?? []) {
    const internal = resolveInternal(file, spec);
    const pkg = packageOf(spec);

    switch (area) {
      case "lib": {
        if (internal !== "" && !internal.startsWith("src/lib")) {
          fail(file, `lib/ must not import internal code (imports "${spec}")`);
        }
        const banned = ["effect", "hono", "drizzle-orm", "zod", "better-auth"];
        if (banned.includes(pkg) || pkg.startsWith("@effect/") || pkg.startsWith("@hono/")) {
          fail(file, `lib/ is framework-agnostic — must not import "${spec}"`);
        }
        break;
      }
      case "domain": {
        if (internal !== "" && !internal.startsWith("src/domain")) {
          fail(file, `domain/ may only import from domain/ (imports "${spec}")`);
        }
        if (pkg !== "" && pkg !== "effect" && !(file.endsWith(".test.ts") && pkg === "vitest")) {
          fail(file, `domain/ is pure — only "effect" is allowed (imports "${spec}")`);
        }
        break;
      }
      case "db": {
        if (internal !== "" && !internal.startsWith("src/db")) {
          fail(file, `db/schema must not import app code (imports "${spec}")`);
        }
        if (pkg !== "" && pkg !== "drizzle-orm") {
          fail(file, `db/schema may only import "drizzle-orm" (imports "${spec}")`);
        }
        break;
      }
      case "infra": {
        if (internal.startsWith("src/modules") || internal.startsWith("src/http")) {
          fail(file, `infra/ must not depend on modules/ or http/ (imports "${spec}")`);
        }
        break;
      }
      case "modules": {
        if (internal.startsWith("src/http") && !isHttpSurface(file)) {
          fail(file, `only *.routes.ts / *.contract.ts may import http/ (imports "${spec}")`);
        }
        if ((pkg === "hono" || pkg.startsWith("@hono/")) && !isHttpSurface(file)) {
          fail(file, `only *.routes.ts / *.contract.ts may import hono (imports "${spec}")`);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Text-based bans that oxlint can't express (conventions, machine-enforced).
//    Run on comment/string-stripped source so a keyword inside a comment or a
//    string literal never triggers a false positive. (Type assertions and
//    ts-directive comments are enforced by oxlint: consistent-type-assertions
//    and ban-ts-comment.)
// ---------------------------------------------------------------------------
const textFiles = [...files, ...scan("scripts/**/*.ts")];
const rawContents = await Promise.all(textFiles.map((file) => Bun.file(file).text()));

/** Blank out comments and string/template literals to avoid false positives. */
const sanitize = (src: string): string =>
  src
    .replaceAll(/\/\*[\S\s]*?\*\//g, " ")
    .replaceAll(/\/\/[^\n]*/g, " ")
    .replaceAll(/`(?:\\.|[^`\\])*`/g, " ")
    .replaceAll(/"(?:\\.|[^"\\])*"/g, " ")
    .replaceAll(/'(?:\\.|[^'\\])*'/g, " ");

type Ban = {
  readonly re: RegExp;
  readonly msg: string;
  readonly scope: (file: string) => boolean;
};

const inSrc = (f: string): boolean => f.startsWith("src/");
const bans: ReadonlyArray<Ban> = [
  {
    re: /\btry\s*\{/,
    msg: "raw try/catch is banned — use Effect.try / Effect.tryPromise (or .finally for cleanup)",
    scope: () => true,
  },
  {
    re: /Record<[^<>]*,\s*(?:unknown|any)\s*>/,
    msg: "Record<_, unknown|any> is banned — model the shape explicitly (or decode it)",
    scope: inSrc,
  },
  {
    re: /\benum\s+[A-Za-z_$]/,
    msg: "TypeScript `enum` is banned — use a `const` array/object + a union type",
    scope: inSrc,
  },
  {
    re: /\bnew Date\(\s*\)|\bDate\.now\(\s*\)|\bMath\.random\(\s*\)/,
    msg: "non-deterministic time/random is banned — use Effect Clock/Random",
    scope: (f) => inSrc(f) && !f.startsWith("src/db/"),
  },
  {
    re: /\b(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork)\b/,
    msg: "Effect run* belongs only at the HTTP/server edge — services return Effects",
    scope: (f) => /^src\/(?:domain|lib|infra|modules)\//.test(f),
  },
];

textFiles.forEach((file, index) => {
  const clean = sanitize(rawContents[index] ?? "");
  for (const ban of bans) {
    if (ban.scope(file) && ban.re.test(clean)) fail(file, ban.msg);
  }
});

if (errors.length > 0) {
  console.error(`✗ Structure check failed (${errors.length} issue(s)):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`✓ Structure check passed (${files.length} files: naming, imports, no try/catch).`);
