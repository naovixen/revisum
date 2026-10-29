# The fixture workload image: a stand-in for a team's own image, for the evidence-mode tests in
# npm run check:containers. It starts from Revisum's run image, itself built from the base image
# pinned in .devcontainer/devcontainer.json, so it holds the system libraries Chromium needs and
# installs nothing. The tests pass the run image's tag in as RUN_IMAGE.
#
# It adds one file: a stand-in for Playwright Test's command line, as "playwright" on the PATH.
# The repository's lockfile holds playwright-core but not Playwright Test, and the image is built
# with no network, so the stand-in runs the fixture suite with the checkout's own playwright-core.
# The browsers and node_modules come from the checkout, which the workload runner mounts read-only.
# See docs/specs/SPEC-35-evidence-mode.md.
ARG RUN_IMAGE
FROM ${RUN_IMAGE}
COPY --chmod=755 playwright-test-stand-in.cjs /usr/local/bin/playwright
