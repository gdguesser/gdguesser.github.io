# guesser.dev

Source for [guesser.dev](https://guesser.dev), Gabriel Dietrich Guesser’s
personal site and engineering writing.

The site is a static Astro project: semantic HTML and CSS by default, with one
small browser script for the persisted light/dark theme. It has no hydrated UI
framework.

## Requirements

- Node.js 22
- npm 10 or newer

## Local development

```bash
npm install
npm run dev
```

Astro serves the local site at `http://localhost:4321`.

## Quality checks

```bash
npm run format:check
npm run lint
npm run check
npm run build
npx playwright install chromium
npm test
```

`npm run check` runs Astro’s TypeScript diagnostics with the strictest Astro
configuration. Playwright smoke tests run against the built site in desktop
and mobile Chromium, check internal links and metadata, and scan public pages
with axe.

Run all checks together after Chromium is installed:

```bash
npm run validate
```

## Project structure

- `src/pages/` — static routes, RSS, writing index, article route, and 404
- `src/content/writing/` — Markdown articles validated by the content schema
- `src/layouts/` — shared metadata, navigation, and article structure
- `src/styles/global.css` — design tokens, responsive layout, and themes
- `scripts/generate-assets.mjs` — deterministic PNG social and app icons
- `public/` — CNAME, robots policy, manifest, icons, and generated social image
- `tests/` — link, metadata, theme, responsive, and accessibility smoke tests

Add an article as Markdown under `src/content/writing/`. Required frontmatter is
defined in `src/content.config.ts`.

## Social and app images

`npm run generate:assets` renders the 1200×630 Open Graph image and PNG app
icons with Sharp. It runs automatically before every build. The source favicon
is `public/favicon.svg`.

## Deployment

`.github/workflows/deploy.yml` builds `dist/`, uploads the supported GitHub
Pages artifact, and deploys it from `main` using GitHub’s OIDC flow. Repository
Pages settings should use **GitHub Actions** as the source.

The project is a GitHub Pages user site with `site` set to
`https://guesser.dev`. `public/CNAME` preserves the custom domain in the
deployed artifact. Pull requests and pushes are validated by
`.github/workflows/ci.yml`.
