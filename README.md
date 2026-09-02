# zerodep-web

[![Deploy](https://github.com/zerodep/0dep.se/actions/workflows/pages.yml/badge.svg)](https://github.com/zerodep/0dep.se/actions/workflows/pages.yml)

Source for **[0dep.se](https://0dep.se)**.

Static landing page for the zerodep org's npm packages and the BPMN
engine ecosystem. Built from a JSON manifest, deployed to GitHub Pages.

## Updating content

- Project list: `data/projects.json`
- About page: `data/profile.json`

```sh
npm test    # red/green TDD loop
npm run build
npm run serve   # http://localhost:8080
```

## Deployment

Hosted on **GitHub Pages**, deployed by `.github/workflows/pages.yml`
(Pages source is set to *GitHub Actions* in the repo settings — nothing
is served from a branch). Every push to `main` (or a manual
`workflow_dispatch`) runs:

1. `npm ci` on the Node version pinned in `.nvmrc`
2. `npm test` — a failing test blocks the deploy
3. `npm run build` — renders the pages, bundles the `/run/` and `/dmn/`
   apps with esbuild into `dist/`, and writes `dist/CNAME`
4. `actions/upload-pages-artifact` + `actions/deploy-pages` publish `dist/`
5. an IndexNow ping (best effort) tells Bing, Yandex, Naver and Seznam to
   re-crawl the deployed URLs

The custom domain is the `primaryDomain` in `data/projects.json`; the
build writes it into `dist/CNAME` and GitHub provisions the TLS
certificate from that. DNS: apex `A` records pointing at GitHub's Pages
IPs (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`).

There is no server side — `dist/` is plain static files, and the runner
pages execute entirely in the browser.
