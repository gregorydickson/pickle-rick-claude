#!/bin/bash
# usage: run1.sh <prompt-name> <rep>
S=/private/tmp/claude-501/-Users-gregorydickson-pickle-rick-claude/1a9760a7-ab27-43f9-8d14-9eb17a27240f/scratchpad/e3b
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
cd $S/run
start=$(date +%s)
claude -p --model claude-opus-5-5 --output-format json --max-turns 2 --tools "" < $S/prompts/$1.txt > $S/raw/$1_r$2.json 2> $S/raw/$1_r$2.stderr
echo "$1 r$2 exit=$? secs=$(( $(date +%s)-start ))" >> $S/raw/runlog.txt
