# Changelog

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
