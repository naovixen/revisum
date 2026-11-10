# Revisum

Revisum independently verifies AI-built web software. It runs human-approved, typed test plans in real headless browsers, audits accessibility, and returns evidence: a result file, a visual report, a PR comment and a review queue whose decisions are recorded.

**Status:** pre-alpha. The repository holds the package skeletons and build gates; no features yet.

## Quick start (development)

On Node 24:

```sh
npm ci
npm run check
npm run check:linux   # the same check on CI's pinned Linux image; needs Docker
```

See `CONTRIBUTING.md` for the workflow and `docs/system-design.md` for the design.

## Licences

This is not a dual licence: you don't choose between the two files. Each package carries exactly one licence, listed in `licences.json` and in its `package.json`:

- **Apache-2.0** (`LICENSE-APACHE`): `contracts`, `driver-cdp`, `auditor-axe` and `report`.
- **FSL-1.1-ALv2** (`LICENSE-FSL`): `engine`, `auditor-act`, `runner` and `cli`. Each release converts to Apache-2.0 two years after it is published.

Everything outside `packages/`, that is `tools/`, `test/` and `docs/`, is FSL-1.1-ALv2. The exception is the schemas that `licences.json` lists under `schemas`, which are Apache-2.0.

We will never move a package to a more restrictive licence than it has today.
