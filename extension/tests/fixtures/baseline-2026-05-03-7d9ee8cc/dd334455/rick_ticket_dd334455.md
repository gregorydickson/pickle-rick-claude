---
id: dd334455
title: "R-FAKE-4 — dd334455 Update disposition data path"
status: Todo
priority: High
mapped_requirements: [R-FAKE-4]
created: 2026-05-03
updated: 2026-05-03
---
# Description

## Problem
The disposition table at `src/data/bundle-disposition-2026-05-04.json` is missing.

## Solution
This was introduced at commit 135b319eaae9b8a1870e9d272cdf92a70fce79a9 which must be
rebased onto the bundle start. Fix the path reference and rebase.

**Dependencies**: none
