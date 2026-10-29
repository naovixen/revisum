# The run image: what a run's browser and its egress proxy run in. It starts from the base image
# the dev container and CI use, pinned by digest in .devcontainer/devcontainer.json, which
# prepareRunImage passes in as BASE_IMAGE. It adds only the system libraries Chromium needs and
# one font family, so text renders. The browsers themselves are not built in: the run mounts the
# pinned builds in .browsers/ read-only. The run's containers start as the image's "node" user.
# See docs/specs/SPEC-07-isolated-runner-and-egress.md.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    libfontconfig1 libfreetype6 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
USER node
