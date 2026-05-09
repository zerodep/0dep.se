# CLAUDE.md

Project-specific guidance for Claude Code when working in this repo.

## What this is

Source for the static landing page hosted at **0dep.se**. Catalogues the zerodep org's npm packages plus the BPMN engine ecosystem. Built by a single Node script from a JSON manifest, deployed to GitHub Pages via Actions.

## Conventions

- **Node 26.** Pinned in `.nvmrc` (read by fnm/nvm) and consumed by `actions/setup-node` via `node-version-file`. Bump in one place when upgrading.
- **TDD.** Write a failing test before the implementation. Use `node:test` (`npm test` runs `node --test test/*.test.js`) plus `jsdom` for DOM-based assertions.
- **Zero runtime dependencies.** Node built-ins only at runtime. Dev tooling can pull in npm packages (jsdom for DOM testing); the Pages workflow runs `npm ci` before tests so `node_modules/` exists in CI.
- **No frameworks, no bundler.** Plain HTML and CSS. The renderer in `src/build.js` is pure string concatenation with explicit HTML escaping.
- **Single source of truth.** Project list lives in `data/projects.json`. Add or remove packages there; tests and the build script consume it.

## Layout

```
data/projects.json   site metadata + project list
src/build.js         renders dist/index.html, copies styles.css, writes CNAME
src/styles.css       styles (auto dark/light)
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
- **BPMN engine ecosystem**: `bpmn-engine`, `bpmn-middleware`, `bpmn-elements`, `smqp`, `moddle-context-serializer` (under `github.com/paed01` and `github.com/zerodep` — same maintainer; locations match each package's published `repository` field), plus `@onify/flow-extensions` (under `github.com/onify`, third-party extension pack).
- **Excluded:** `feelin` (owned by Camunda / nikku, not Pål's), `www` (the legacy Express site for zerodep), and any `private: true` workspace package (`dtstest`, `feel-extensions`, `piso-benchmark`, `import-test`, `expression`).
