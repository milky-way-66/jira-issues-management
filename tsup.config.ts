import { defineConfig } from 'tsup'

/**
 * Bundles `src/` into a single ESM entry point.
 *
 * Runtime dependencies are left external rather than bundled. They are declared
 * in `package.json`, so npm installs them anyway — and bundling a CommonJS
 * package (commander) into an ESM output produces a `Dynamic require of
 * "events" is not supported` crash on the very first command. That failure only
 * appears in the built artefact, never when running from source, which is why
 * the release script smoke-tests `dist/` rather than trusting a green suite.
 *
 * Keep this list in step with `dependencies` in package.json.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  external: ['commander', 'yaml', 'zod'],
})
