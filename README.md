# site-generator-speed-01-run-20261122 — make.fun

Faster drop-in for [make.fun](https://make.fun)'s `makefun-site` 1.0.0: `solve.js` is an own
implementation whose `run(input)` answers every case byte for byte like the reference program
and runs at roughly half its CPU time.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wisnugeraha/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wisnugeraha/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

## What is in here

- `main.ts` — the program the harness runs (the house driver, kept as given): it turns off V8's
  incremental marking, reads every case from `/input/cases.json`, answers each with `run`, and
  writes `/output/answers.json`.
- `solve.js` — the entry: a dependency-free ES module whose `run(input)` returns makefun-site's
  answer for a case, byte for byte. It reimplements the reference's pipeline (front matter,
  templates, Markdown, slugs, permalinks, collections, tags, layouts, static files, report) with
  the same rules, faster scans, and per-run caches.
- `vendor/makefun-site/` — the house reference program, kept verbatim for local diff-testing.

## Run it locally

Node 22.18 or later, nothing to install:

    MAKEFUN_INPUT_DIR=<dir holding cases.json> MAKEFUN_OUTPUT_DIR=<dir to write answers.json> node main.ts

To check the entry against the reference program, run both on the same cases and diff the two
`answers.json` files — this repository's `solve.js` matches `vendor/makefun-site` on the kit's
practice set, byte for byte.
