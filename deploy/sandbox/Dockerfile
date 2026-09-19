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
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
