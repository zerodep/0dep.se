# zerodep-web

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

Push to `main` and the workflow rebuilds and deploys.
