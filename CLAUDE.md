# CLAUDE.md

Project-specific guidance for Claude Code when working in this repo.

## What this is

Source for the static landing page hosted at **0dep.se**. Catalogues the zerodep org's npm packages plus the BPMN engine ecosystem. Built by a single Node script from a JSON manifest, deployed to GitHub Pages via Actions.

## Conventions

- **Node 26.** Pinned in `.nvmrc` (read by fnm/nvm) and consumed by `actions/setup-node` via `node-version-file`. Bump in one place when upgrading.
- **TDD.** Write a failing test before the implementation. Use `node:test` (`npm test` runs `node --test test/*.test.js`) plus `happy-dom` for DOM-based assertions.
- **Zero runtime dependencies.** Node built-ins only at runtime. Dev tooling can pull in npm packages (happy-dom for DOM testing); the Pages workflow runs `npm ci` before tests so `node_modules/` exists in CI.
- **No frameworks, no bundler** for the pages themselves. Plain HTML and CSS. The renderer in `src/build.js` is pure string concatenation with explicit HTML escaping. Exception: the runner pages (`/run/`, `/dmn/`, `/tools/`) ship ESM bundles built by esbuild from `src/runner/` — all devDependencies, bundled at build time (bpmn-elements needs `>=18.0.22` — browser-safe timers, the `Expressions` export, step-mode transaction/compensation completion, the `accepts` array on postponed content, cancellable conditional events, and the `assignOutput` setting that merges output of plain elements @0dep/bpmn-extensions skips — still on the `rc` dist-tag until 18 goes latest; @0dep/bpmn-extensions `>=0.0.6` for its cron-capable `TimerEventDefinition`, registered in the runner's type resolver — it peer-depends on `croner`, declared as a devDependency so the bundle picks it up). The zeebe and camunda schemas conflict in moddle (same `modelerTemplate` extension property), so the runner registers one per parse based on the xmlns in the source. The `/tools/` page keeps its attempt history in `localStorage` under `0dep-tools-history` (50 entries, deduped by tool+input+options). Each runner page has its own service worker (`run-`/`dmn-`/`tools-` cache prefixes).
- **Single source of truth.** Project list lives in `data/projects.json`. Add or remove packages there; tests and the build script consume it. Each project's `runtimeDeps` must mirror the package's published `dependencies` (not peers) — a test cross-checks against whatever is installed in `node_modules`.
- **Design language.** The site is drawn in BPMN notation: groups = lanes, cards = tasks. Chromatic color means *live* only (`--token`); everything else is ink/paper/grid tokens. Fonts are self-hosted OFL subsets in `src/assets/fonts/` (keep the licence files beside them) because the CSP is same-origin.

## Deploy notes

- GitHub Pages serves `dist/`. Source: **GitHub Actions** (set in repo settings).
- Primary apex domain is `0dep.se`, written into `dist/CNAME` by the build. GitHub auto-provisions a Let's Encrypt cert for whatever is in `CNAME`.
- `zerodep.se` is also owned but its DNS isn't managed by us, so it isn't listed on the page or pointed at GitHub Pages. If that ever changes, swap `primaryDomain` in the manifest, or list it under `altDomains` once it redirects.
- Apex `A` records must point at GitHub's Pages IPs (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`).

## Project list scope

- **zerodep packages** (under `github.com/zerodep`): `@0dep/piso`, `@0dep/pino-applicationinsights`, `ocrgenerator`, `texample`.
- **BPMN engine ecosystem**: `bpmn-engine`, `bpmn-middleware`, `bpmn-elements`, `dmn-elements`, `smqp`, `moddle-context-serializer` (under `github.com/paed01` and `github.com/zerodep` — same maintainer; locations match each package's published `repository` field), plus `@onify/flow-extensions` (under `github.com/onify`, third-party extension pack).
- **Excluded:** `feelin` (owned by Camunda / nikku, not Pål's), `www` (the legacy Express site for zerodep), and any `private: true` workspace package (`dtstest`, `feel-extensions`, `piso-benchmark`, `import-test`, `expression`).
