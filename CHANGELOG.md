# Changelog

## v1.6.0 - 2026-09-04

- worth a look: unnecessary (files never loaded during testing) and @aller/google-cloud-secret (etag-locked Secret Manager updates)
- tests: `npm test` reports untouched source files through the unnecessary node:test reporter (V8 coverage, `dist/` excluded) and runs README examples with texample in `posttest`
- the MCP server test closes stdin instead of killing the child so the server exits on its own
- `src/serve.js` exports `createStaticServer(root)` and only listens when run directly (`import.meta.main`), so the dev server is covered by tests

## v1.5.0 - 2026-09-02

- `/tools/`: an interval's repeat renders as what it means — `R-1` reads as "forever", or "until the end date" when the interval has one; counted repeats as "n times"
- `/run/` and MCP `run_bpmn`: cron `timeCycle`s (Camunda 8 timer start events, e.g. `0 1 * * *`) parse through @0dep/bpmn-extensions' `TimerEventDefinition`
- dependencies: @0dep/bpmn-extensions 0.0.6 (+ its peer croner 10)
- visual identity: the site is drawn in the notation it executes — groups are lanes in a pool, cards are task shapes; `logo.png` is trimmed to the wordmark (the square original ships as `og-image.png` for social cards and JSON-LD); the about-page avatar sits inside an ink ring, downscaled from 646 KB
- tokens: ink on diagram paper with one live color (the green, for links and running/matched/valid states) and a cool ground instead of warm cream; dark mode is the canvas inverted
- type: Jost for display, IBM Plex Sans for body, IBM Plex Mono for anything pasteable — self-hosted OFL woff2 latin subsets (77 KB, precached by the runner service workers), same-origin CSP unchanged
- every card opens with its honest runtime dependency count from the new `runtimeDeps` manifest field (zero renders as the ring mark; otherwise "builds on …" linking sibling cards); a test cross-checks the lists against installed packages
- card and group links lead with a verb ("Parse ISO 8601 →", "Run a diagram in your browser →"); footer links are named (GitHub · npm · LinkedIn) instead of raw URLs
- sub pages link home through the ring mark (`logo-mark.png`, the logo without its wordmark) in the back link
- `/dmn/`: a decision table without a declared output column now renders square (orphan rule output cells get unnamed header columns) with a visible warning that evaluation will fail — previously the grid skewed silently until a DecisionError at evaluate

## v1.4.0 - 2026-08-30

- new `/tools/` page: parse ISO 8601 dates, durations and intervals with @0dep/piso, validate or generate Swedish bankgiro OCR references with ocrgenerator — a browser-local history (localStorage, 50 entries) restores and re-runs previous attempts; own bundle and `tools-` offline cache; piso and ocrgenerator cards link to it
- dependencies: @0dep/piso 5.1, ocrgenerator 3.0

## v1.3.0 - 2026-08-29

- dependencies: @0dep/bpmn-extensions 0.0.5, zeebe-bpmn-moddle 2.0, camunda-bpmn-moddle 8.0
- `/run/`: @0dep/bpmn-extensions 0.0.5 no longer attaches to elements without zeebe extension data, which dropped the completion payload of plain user tasks — the runner now sets bpmn-elements' `assignOutput: 'auto'` so signaled JSON payloads still land in the run output
- requires bpmn-elements >= 18.0.22 (`assignOutput` setting, `rc` dist-tag)

## v1.2.0 - 2026-08-21

- the `/dmn/` decision picker preselects the DRG's output decision (the one no other decision requires), so evaluating a chained model exercises the whole graph by default
- MCP support: `npm run mcp` starts a stdio MCP server (hand-rolled JSON-RPC 2.0, no SDK dependency) exposing `run_bpmn` (auto-signaled waits, DMN-backed business rule tasks, loop guard), `evaluate_dmn` (defaults to the output decision, returns result + trace), and `list_dmn_decisions` (with required inputs) — the same engine wiring the runner pages use
- beyond-Google SEO: IndexNow key + deploy-time ping (Bing, Yandex, Naver, Seznam) and a generated `llms.txt` site summary for AI crawlers
- `/dmn/` SEO pass: title/description/keywords target "online dmn runner", "dmn evaluator", "camunda dmn", and requirement-graph searches; the crawlable about text and WebApplication featureList cover chained decisions, the input form, and Camunda Modeler / dmn-js exports; "online bpmn and dmn runner" added to the `/run/` and home keywords

## v1.1.0 - 2026-08-21

- new `/dmn/` page: evaluate DMN decisions entirely in the browser — paste or drop a `.dmn`, pick a decision (decision services included), evaluate with JSON input data, powered by dmn-elements
- decision tables rendered as plain HTML (no dmn-js): hit policy in the caption, matched rules highlighted after evaluation, literal expressions shown verbatim
- evaluation trace via `Definition#trace` — evaluated elements in completion order with decision logic, hit policy, matched rule ids, and per-element results — plus the forwarded engine log
- best-effort input form for the selected decision, above the rendered tables: declared `inputData` (walked transitively through the requirement graph, bound input decisions for decision services) renders as typed fields — number/text inputs, true/false select for booleans — filled fields win over the JSON input data, empty ones fall back to it; Evaluate submits the form (Enter in a field works), and with nothing declared it plainly evaluates
- two demo services registered for FEEL: `services.takeOnce("key")` grants true once per evaluation (fresh per run), `services.exchangeRate("USD")` serves async-loaded rates through a sync accessor — service functions themselves must be synchronous, a promise-returning one fails loudly
- `/run/` business rule tasks: the environment's services now ride into dmn-elements, so decisions called by `zeebe:calledDecision` can invoke `services.<name>` in FEEL
- dropped DMN files on `/run/` also list decision services, and both runner pages cross-link; home nav and the dmn-elements card link to `/dmn/` ("Try it live"); `/dmn/` listed in the sitemap
- offline support via its own service worker (`dmn-` cache, kept apart from the `run-` cache); same-origin CSP without `unsafe-inline`
- internal: `src/runner/app.js` renamed to `bpmn-app.js` (public URL `/run/app.js` unchanged), shared `dmn-runner.js` and `take-helper.js` modules, `test/app-ui.test.js` renamed to `bpmn-ui.test.js`

## v1.0.0 - 2026-08-21

- new `/run/` page: execute BPMN 2.0 diagrams entirely in the browser — paste or drop, powered by bpmn-elements with @0dep/bpmn-extensions (FEEL, zeebe extension elements)
- camunda 7 diagrams run through: dummy services, pass-through script formats, `${...}` template expressions; plain (non-FEEL) flow conditions warn before the run
- business rule tasks evaluate DMN decision tables (dmn-elements) — drop `.dmn` files in the decisions list, re-drops replace by file name or decision id
- diagram rendered with bpmn-js: live run markers, taken counters (slate for flows), click-to-inspect properties with per-run counts, vertical resize with auto-refit
- execution controls: step mode (sub-processes and transactions included), signal with JSON payload, cancellable timers and conditional events, discard marking, bypass for manual/user tasks, loop guard (10/20/50 touches)
- execution stats panel with live `activityStatus`, collapsible execution log with DMN evaluation trace
- `takeOnce`/`takeTwice` helpers make circular flows terminate
- offline support via service worker; same-origin CSP; nothing is transmitted — diagrams never leave the browser
- run page SEO: WebApplication + FAQPage JSON-LD, crawlable FAQ, source repo link
- requires bpmn-elements >= 18.0.20 (`rc` dist-tag)
