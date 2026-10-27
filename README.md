# Revisum

Revisum independently verifies AI-built web software. It runs human-approved, typed test plans in real headless browsers, audits accessibility, and returns evidence: a result file, a visual report, a PR comment and a review queue whose decisions are recorded.

**Status:** pre-alpha. The repository holds the package skeletons and build gates; no features yet.

## Quick start (development)

Work inside the dev container (`.devcontainer/`), on Node 24:

```sh
npm ci
npm run check
```

See `CONTRIBUTING.md` for the workflow and `docs/system-design.md` for the design.

## Licences

Each package carries one licence, listed in `licences.json`:

- **Apache-2.0** (`LICENSE-APACHE`): `contracts`, the drivers, `auditor-axe`, `report` and `action`.
- **FSL-1.1-ALv2** (`LICENSE-FSL`): `engine`, `auditor-act`, `runner` and `cli`. Each release converts to Apache-2.0 two years after it is published.

We will never move a package to a more restrictive licence than it has today.
