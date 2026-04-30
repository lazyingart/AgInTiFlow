FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  findutils \
  gawk \
  git \
  grep \
  npm \
  nodejs \
  python3-pip \
  python3-venv \
  python3 \
  ripgrep \
  sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
