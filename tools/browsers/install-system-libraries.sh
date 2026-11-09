#!/usr/bin/env bash
# Installs the system libraries Chromium needs on Linux, run as root. CI, the dev container and the
# weekly browser upkeep job all use it, so the three agree. The first group is the same list as
# packages/runner/image/Dockerfile; keep them in step. xvfb and xclip are for the host clipboard
# proof in test/browser/clock-and-clipboard/support/HostClipboard.ts, which reports itself unavailable without them.
set -euo pipefail
apt-get update
apt-get install --yes --no-install-recommends \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
  libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  libfontconfig1 libfreetype6 fonts-liberation \
  xvfb xclip
rm -rf /var/lib/apt/lists/*
