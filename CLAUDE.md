# CLAUDE.md

Project-specific guidance for Claude Code when working in this repo.

## What this is

Source for the static landing page hosted at **0dep.se**. Catalogues the zerodep org's npm packages plus the BPMN engine ecosystem. Built by a single Node script from a JSON manifest, deployed to GitHub Pages via Actions.

## Conventions

- **Node 26.** Pinned in `.nvmrc` (read by fnm/nvm) and consumed by `actions/setup-node` via `node-version-file`. Bump in one place when upgrading.
- **TDD.** Write a failing test before the implementation. Use `node:test` (`npm test` runs `node --test test/*.test.js`) plus `happy-dom` for DOM-based assertions.
- **Zero runtime dependencies.** Node built-ins only at runtime. Dev tooling can pull in npm packages (happy-dom for DOM testing); the Pages workflow runs `npm ci` before tests so `node_modules/` exists in CI.
- **No frameworks, no bundler** for the pages themselves. Plain HTML and CSS. The renderer in `src/build.js` is pure string concatenation with explicit HTML escaping. Exception: the `/run/` demo page ships ESM bundles built by esbuild from `src/runner/` — `dist/run/app.js` (bpmn-elements, @0dep/bpmn-extensions, bpmn-moddle, moddle-context-serializer, zeebe + camunda moddle schemas, dmn-elements + dmn-moddle for business rule tasks) plus a code-split lazy chunk for the bpmn-js viewer under `dist/run/chunks/`. All devDependencies, bundled at build time (bpmn-elements needs `>=18.0.20` — browser-safe timers, the `Expressions` export, step-mode transaction/compensation completion, the `accepts` array on postponed content, and cancellable conditional events — still on the `rc` dist-tag until 18 goes latest). The zeebe and camunda schemas conflict in moddle (same `modelerTemplate` extension property), so the runner registers one per parse based on the xmlns in the source. The `/dmn/` page is a standalone DMN evaluator — a single esbuild bundle `dist/dmn/app.js` (dmn-elements + dmn-moddle, no code splitting) that renders decision tables as plain HTML with matched-rule highlighting; each runner page has its own service worker (`run-`/`dmn-` cache prefixes).
- **Single source of truth.** Project list lives in `data/projects.json`. Add or remove packages there; tests and the build script consume it.

## Layout

```
data/projects.json   site metadata + project list
src/build.js         renders dist/index.html, copies styles.css, writes CNAME
src/styles.css       styles (auto dark/light)
src/runner/          browser runners: bpmn-runner.js (engine wiring), bpmn-app.js (/run/ page UI, esbuild entry),
                     dmn-runner.js (dmn-elements wiring, shared with bpmn-runner), dmn-app.js (/dmn/ page UI, esbuild entry),
                     take-helper.js (takeOnce/takeTwice counters shared by both runners)
src/serve.js         dev server on :8080
test/                node:test specs (manifest schema + rendered HTML)
.github/workflows/   GitHub Pages deploy
dist/                build output (gitignored)
```

## Deploy notes

- GitHub Pages serves `dist/`. Source: **GitHub Actions** (set in repo settings).
- Primary apex domain is `0dep.se`, written into `dist/CNAME` by the build. GitHub auto-provisions a Let's Encrypt cert for whatever is in `CNAME`.
- `zerodep.se` is also owned but its DNS isn't managed by us, so it isn't listed on the page or pointed at GitHub Pages. If that ever changes, swap `primaryDomain` in the manifest, or list it under `altDomains` once it redirects.
- Apex `A` records must point at GitHub's Pages IPs (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`).

## Project list scope

- **zerodep packages** (under `github.com/zerodep`): `@0dep/piso`, `@0dep/pino-applicationinsights`, `ocrgenerator`, `texample`.
- **BPMN engine ecosystem**: `bpmn-engine`, `bpmn-middleware`, `bpmn-elements`, `dmn-elements`, `smqp`, `moddle-context-serializer` (under `github.com/paed01` and `github.com/zerodep` — same maintainer; locations match each package's published `repository` field), plus `@onify/flow-extensions` (under `github.com/onify`, third-party extension pack).
- **Excluded:** `feelin` (owned by Camunda / nikku, not Pål's), `www` (the legacy Express site for zerodep), and any `private: true` workspace package (`dtstest`, `feel-extensions`, `piso-benchmark`, `import-test`, `expression`).
