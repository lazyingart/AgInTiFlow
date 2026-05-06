FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  file \
  findutils \
  gawk \
  git \
  grep \
  npm \
  nodejs \
  latexmk \
  poppler-utils \
  python3-matplotlib \
  python3-numpy \
  python3-pip \
  python3-venv \
  python3 \
  ripgrep \
  sed \
  sudo \
  texlive-fonts-recommended \
  texlive-latex-base \
  texlive-latex-extra \
  texlive-latex-recommended \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
