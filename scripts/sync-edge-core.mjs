#!/usr/bin/env node
// Copies the packages/core modules used by the okx-collector Edge Function into
// supabase/functions/okx-collector/core. Deno needs explicit ".ts" specifiers, so
// "./x.js" is rewritten to "./x.ts". Run with --check in CI to fail when the copies are stale.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "packages/core/src");
const outputDir = path.join(root, "supabase/functions/okx-collector/core");
const MODULES = ["types", "okx", "symbols", "auth", "collector"];
const HEADER = "// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.\n";
const checkOnly = process.argv.includes("--check");

const allowedLocal = new Set(MODULES.map((name) => `./${name}.js`));

function rewrite(name, source) {
  const specifiers = [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (specifier.startsWith("node:") || !specifier.startsWith(".")) continue;
    if (!allowedLocal.has(specifier)) {
      throw new Error(`${name}.ts imports "${specifier}", which is not in the Edge Function core set`);
    }
  }
  return HEADER + source.replace(/from "(\.\/[a-z]+)\.js"/g, 'from "$1.ts"');
}

const outputs = new Map();
for (const name of MODULES) {
  const source = await readFile(path.join(sourceDir, `${name}.ts`), "utf8");
  outputs.set(`${name}.ts`, rewrite(name, source));
}

if (checkOnly) {
  const stale = [];
  for (const [file, expected] of outputs) {
    const current = await readFile(path.join(outputDir, file), "utf8").catch(() => null);
    if (current !== expected) stale.push(file);
  }
  if (stale.length > 0) {
    console.error(`Edge Function core copies are stale: ${stale.join(", ")}. Run: node scripts/sync-edge-core.mjs`);
    process.exit(1);
  }
  console.info(`Edge Function core copies are up to date (${MODULES.length} modules)`);
} else {
  await mkdir(outputDir, { recursive: true });
  for (const [file, contents] of outputs) {
    await writeFile(path.join(outputDir, file), contents);
  }
  console.info(`wrote ${outputs.size} modules to ${path.relative(root, outputDir)}`);
}
