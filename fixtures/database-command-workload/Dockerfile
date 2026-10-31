# The fixture database-command image: a stand-in for a team's own image holding a database client,
# for the database-command tests in npm run check:containers. It starts from Revisum's run image,
# itself built from the base image pinned in .devcontainer/devcontainer.json, so it has Node and
# installs nothing. The tests pass the run image's tag in as RUN_IMAGE.
#
# It adds one file, the fixture program every declared command runs.
# See docs/specs/SPEC-36-unsafe-plan-features.md.
ARG RUN_IMAGE
FROM ${RUN_IMAGE}
COPY database-fixture.mjs /opt/database-fixture/database-fixture.mjs
