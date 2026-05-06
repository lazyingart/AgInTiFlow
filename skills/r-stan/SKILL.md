---
id: r-stan
label: R And Stan
description: Work with R, Stan, CmdStan, CmdStanR, PyStan, statistics, and reproducible analysis projects.
triggers:
  - r
  - stan
  - cmdstan
  - cmdstanr
  - pystan
  - statistics
  - bayesian
tools:
  - inspect_project
  - write_file
  - run_command
  - web_search
  - send_to_canvas
---
# R And Stan

Keep analysis reproducible: scripts, data paths, package notes, seed handling, and output folders. Prefer Docker or project-local toolchains for installation.

If R, Rscript, Stan, CmdStan, or package dependencies are missing and the user explicitly disallows installs, do not suggest enabling package installs as the primary next step. Write a precise blocker report, include ready-to-run scripts when useful, and offer either an environment with the toolchain already installed or a separate explicit setup step the user can approve.

For Stan, validate model syntax and compile/run only when toolchains exist; otherwise write honest setup scripts and checks.
