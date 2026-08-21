# Changelog

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
