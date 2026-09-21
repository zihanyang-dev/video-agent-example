# The machine a turn gets.
#
# Everything the agent can reach lives here. There are no tools beyond what a shell can run,
# which is the point: a capability arrives as a command or a file, never as infrastructure
# the agent is forced to perceive (architecture.md §8).
#
# `file` is not incidental -- it is how the read tool decides something is an image worth
# showing the model, which is what makes "render, then look at a frame" possible.
FROM debian:bookworm-slim

# Measured from Shanghai: `apt-get update` takes 261s against deb.debian.org and 2s against
# this one. Override it anywhere that is not true:
#
#   docker build --build-arg APT_MIRROR=deb.debian.org deploy/sandbox
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    ffmpeg \
    file \
    ca-certificates \
    curl \
    python3 \
    gnupg \
    git \
  && rm -rf /var/lib/apt/lists/*

# HyperFrames composes video by rendering HTML, so it needs Node and a browser. Its CLI is
# non-interactive by design -- the same reason this whole architecture works: a capability
# the agent reaches through a command, not through a tool we wrote.
ARG NODE_MAJOR=22
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1 \
  && apt-get install -y -qq --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Chromium from the distribution rather than the one Puppeteer downloads: the download is
# x86-only on some mirrors and the distribution build matches the architecture we are on.
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g hyperframes@0.8 >/dev/null 2>&1

# GSAP, on disk, because the sandbox reaches exactly one thing and that thing is the gateway
# (architecture.md §8). HyperFrames drives a composition by seeking a GSAP timeline, and the
# project it scaffolds loads GSAP from a CDN -- which here is a script that never arrives and
# a composition that renders one still frame for its whole duration. A skill writing a
# composition points at this copy instead.
ARG GSAP_VERSION=3.14.2
RUN npm install -g gsap@${GSAP_VERSION} >/dev/null 2>&1 \
  && mkdir -p /opt/vendor \
  && cp /usr/lib/node_modules/gsap/dist/gsap.min.js /opt/vendor/gsap.min.js

# Skills do not go looking for it. One name, stable across upgrades.
ENV VID_GSAP=/opt/vendor/gsap.min.js

# Nothing here can reach a telemetry endpoint, so every render would spend its time finding
# that out. Turned off at build time rather than per run.
RUN hyperframes telemetry disable >/dev/null 2>&1 || true

WORKDIR /work
