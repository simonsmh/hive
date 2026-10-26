#!/usr/bin/env node
// Copies the packages/core modules used by each Edge Function into that function's core/ directory.
// Deno needs explicit ".ts" specifiers, so "./x.js" is rewritten to "./x.ts". Run with --check in CI to
// fail when any copy is stale.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "packages/core/src");
const functionsDir = path.join(root, "supabase/functions");
const HEADER = "// Generated from packages/core/src by scripts/sync-edge-core.mjs. Do not edit by hand.\n";
const checkOnly = process.argv.includes("--check");

/** Module list per Edge Function. Each module may import only the local modules listed for the same function. */
const FUNCTIONS = {
  "okx-collector": ["types", "okx", "symbols", "auth", "collector"],
  "jin10-poller": ["auth", "news"],
  "blockbeats-poller": ["auth", "news"],
  "okx-news-poller": ["auth", "news", "okx-news", "okx-signing"],
  "webhook-dispatcher": ["auth", "webhook"],
  "alert-evaluator": ["types", "alerts", "auth"],
  "yahoo-collector": ["types", "okx", "symbols", "auth", "collector", "yahoo", "yahoo-cycle"],
  "ths-collector": ["types", "auth", "ths-plan", "ths", "ths-market", "ths-cycle"],
  "google-finance-collector": ["auth", "google-finance"],
  "order-submit": ["auth", "okx-signing", "okx-trade", "order-intent", "position"],
  "position-manager": ["types", "okx", "auth", "okx-signing", "okx-trade", "order-intent", "atr", "position"],
  "position-subscriptions": ["auth", "position"],
  "push-notify": ["auth", "webpush"],
  "strategy-evaluator": ["types", "auth", "okx-signing", "okx-trade", "order-intent", "position", "strategy"],
  "trend-evaluator": ["types", "auth", "okx-signing", "okx-trade", "order-intent", "position", "atr", "indicators", "trend"],
  "order-sync": ["auth", "okx-signing", "okx-trade", "order-intent", "position"],
};

function rewrite(name, source, allowedLocal) {
  const specifiers = [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (specifier.startsWith("node:") || !specifier.startsWith(".")) continue;
    if (!allowedLocal.has(specifier)) {
      throw new Error(`${name}.ts imports "${specifier}", which is not in this function's core set`);
    }
  }
  return HEADER + source.replace(/from "(\.\/[a-z0-9-]+)\.js"/g, 'from "$1.ts"');
}

const stale = [];
let written = 0;
for (const [fn, modules] of Object.entries(FUNCTIONS)) {
  const outputDir = path.join(functionsDir, fn, "core");
  const allowedLocal = new Set(modules.map((name) => `./${name}.js`));
  const outputs = new Map();
  for (const name of modules) {
    const source = await readFile(path.join(sourceDir, `${name}.ts`), "utf8");
    outputs.set(`${name}.ts`, rewrite(name, source, allowedLocal));
  }

  if (checkOnly) {
    for (const [file, expected] of outputs) {
      const current = await readFile(path.join(outputDir, file), "utf8").catch(() => null);
      if (current !== expected) stale.push(`${fn}/core/${file}`);
    }
    continue;
  }

  await mkdir(outputDir, { recursive: true });
  for (const [file, contents] of outputs) {
    await writeFile(path.join(outputDir, file), contents);
    written += 1;
  }
}

if (checkOnly) {
  if (stale.length > 0) {
    console.error(`Edge Function core copies are stale: ${stale.join(", ")}. Run: node scripts/sync-edge-core.mjs`);
    process.exit(1);
  }
  console.info(`Edge Function core copies are up to date (${Object.keys(FUNCTIONS).length} functions)`);
} else {
  console.info(`wrote ${written} module copies for ${Object.keys(FUNCTIONS).length} Edge Functions`);
}
