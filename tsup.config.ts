import { defineConfig } from "tsup";

/**
 * The bundle embeds the SVG paths of `lucide-static` (ISC), some of them
 * derived from Feather (MIT). Both licences require their notice to travel
 * with every copy, and `files` ships `dist/` alone: the banner is what makes
 * the notice inseparable from the redistributed code. THIRD-PARTY-NOTICES.txt
 * carries the full texts.
 */
const THIRD_PARTY_BANNER = [
  "/*",
  " * agentsdir bundles icon paths from lucide-static 1.35.0",
  " * ISC License, Copyright (c) 2026 Lucide Icons and Contributors.",
  " * Some of those icons are derived from Feather:",
  " * MIT License, Copyright (c) 2013-present Cole Bemis.",
  " * Full texts: THIRD-PARTY-NOTICES.txt, shipped with this package.",
  " */",
].join("\n");

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  splitting: false,
  clean: true,
  banner: { js: THIRD_PARTY_BANNER },
});
