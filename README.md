# zerodep-web

Source for the landing page at **[zerodep.se](https://zerodep.se)**.

Static HTML, no runtime dependencies. The page is rendered from a single
JSON manifest (`data/projects.json`) by a plain Node script.

## Layout

```
data/projects.json   # site metadata + project list
src/build.js         # renders dist/index.html from the manifest
src/styles.css       # styles (copied to dist/ as-is)
src/serve.js         # tiny dev server for dist/
test/                # node:test specs (manifest schema + build output)
.github/workflows/   # GitHub Pages deploy
```

## Workflow

```sh
node --test test/    # red/green TDD loop
node src/build.js    # write dist/
node src/serve.js    # http://localhost:8080
```

Add or update a project by editing `data/projects.json`. Tests assert that
every project has the required fields and that each one ends up in the
rendered HTML.

## Hosting

GitHub Pages serves `dist/` via the `.github/workflows/pages.yml` workflow.
Enable Pages in the repo settings under **Pages → Source: GitHub Actions**.

### Domains and TLS

- **Primary**: `zerodep.se` — listed in `dist/CNAME`. GitHub provisions a
  Let's Encrypt certificate automatically once DNS resolves to the Pages IPs.
  Set the apex `A` records to GitHub's published Pages addresses
  (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`)
  and tick **Enforce HTTPS** in the repo's Pages settings.
- **Secondary**: `0dep.se` — GitHub Pages issues an auto-cert for only the
  one apex in `CNAME`, so set this up at the registrar (Loopia / Binero
  both offer URL forwarding with HTTPS) as a 301 redirect to
  `https://zerodep.se`. If registrar forwarding isn't an option, host a
  one-line redirect site from a second Pages repo.
