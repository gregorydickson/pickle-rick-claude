#!/usr/bin/env python3
"""Field timing report for Pickle Rick sessions — numbers only, no client data.

Run it on the machine where the field sessions live:

    python3 field-timing.py [SESSIONS_DIR] [--since YYYY-MM-DD] [--json]

SESSIONS_DIR defaults to ~/.local/share/pickle-rick/sessions.

Prints, per session: per-phase minutes (from pipeline-runner.log), the pickle phase split into worker-spawn
minutes vs everything else (manager turns, gates, relaunches), ticket and iteration counts, anatomy passes per
lane, and whether the run was scoped. The target repo is shown only as an 8-char hash of its path. Ticket text,
file paths, log contents and finding text are never printed, so the output is safe to paste into a public repo.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

PHASE_RE = re.compile(r"^\[(?P<ts>[^\]]+)\] (?:PHASE \d+/\d+: (?P<start>[A-Z-]+)|Phase (?P<end>[a-z-]+) (?:exited|completed))")


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def phase_minutes(sess):
    path = os.path.join(sess, "pipeline-runner.log")
    if not os.path.exists(path):
        return {}
    starts, out = {}, {}
    with open(path, errors="ignore") as fh:
        for line in fh:
            m = PHASE_RE.match(line)
            if not m:
                continue
            ts = parse_ts(m.group("ts"))
            if ts is None:
                continue
            if m.group("start"):
                starts[m.group("start").lower()] = ts
            elif m.group("end") and m.group("end") in starts and m.group("end") not in out:
                out[m.group("end")] = round((ts - starts[m.group("end")]).total_seconds() / 60, 1)
    return out


def birth(st):
    return getattr(st, "st_birthtime", None) or st.st_ctime


def worker_minutes(sess):
    """Sum of (last write - creation) over every worker_session_*.log: time spent inside worker spawns."""
    total, spawns = 0.0, 0
    for root, _dirs, files in os.walk(sess):
        if root.count(os.sep) - sess.count(os.sep) > 1:
            continue
        for f in files:
            if f.startswith("worker_session_") and f.endswith(".log"):
                st = os.stat(os.path.join(root, f))
                total += max(0.0, st.st_mtime - birth(st))
                spawns += 1
    return round(total / 60, 1), spawns


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def tickets(sess):
    n, tiers = 0, {}
    for d in os.listdir(sess):
        p = os.path.join(sess, d, f"rick_ticket_{d}.md")
        if os.path.isfile(p):
            n += 1
            with open(p, errors="ignore") as fh:
                m = re.search(r"^complexity_tier:\s*(\w+)", fh.read(4000), re.M)
            tier = m.group(1) if m else "none"
            tiers[tier] = tiers.get(tier, 0) + 1
    return n, tiers


def session_row(sess):
    state = read_json(os.path.join(sess, "state.json")) or {}
    wd = state.get("working_dir") or ""
    phases = phase_minutes(sess)
    worker_min, spawns = worker_minutes(sess)
    n_tickets, tiers = tickets(sess)
    ap = read_json(os.path.join(sess, "anatomy-park.json")) or {}
    scope = read_json(os.path.join(sess, "scope.json"))
    lanes = read_json(os.path.join(sess, "archive", "lanes.json"))
    pickle_min = phases.get("pickle")
    return {
        "session": os.path.basename(sess),
        "repo_hash": hashlib.sha256(wd.encode()).hexdigest()[:8] if wd else None,
        "phases_min": phases,
        "pickle_min": pickle_min,
        "worker_spawn_min": worker_min,
        "outside_workers_min": round(pickle_min - worker_min, 1) if pickle_min is not None else None,
        "worker_spawns": spawns,
        "tickets": n_tickets,
        "tiers": tiers,
        "iterations": sum(1 for f in os.listdir(sess) if f.startswith("tmux_iteration_") and f.endswith(".log")),
        "anatomy_passes": ap.get("pass_counts") or {},
        "scoped": scope is not None,
        "scope_paths": len((scope or {}).get("allowed_paths") or []),
        "lane_outcomes": [l.get("outcome") for l in lanes] if isinstance(lanes, list) else None,
        "exit_reason": state.get("exit_reason"),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    since = None
    if "--since" in sys.argv:
        since = sys.argv[sys.argv.index("--since") + 1]
        args = [a for a in args if a != since]
    root = os.path.expanduser(args[0] if args else "~/.local/share/pickle-rick/sessions")
    rows = []
    for name in sorted(os.listdir(root)):
        sess = os.path.join(root, name)
        if not os.path.isdir(sess) or (since and name[:10] < since):
            continue
        row = session_row(sess)
        if row["phases_min"] or row["tickets"]:
            rows.append(row)
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=1))
        return
    print(f"{'session':<22} {'repo':<8} {'tix':>3} {'pickle':>7} {'workers':>7} {'outside':>7} {'anatomy':>7} {'szech':>6} scoped passes")
    for r in rows:
        p = r["phases_min"]
        print(f"{r['session']:<22} {str(r['repo_hash']):<8} {r['tickets']:>3} {str(p.get('pickle','-')):>7} "
              f"{r['worker_spawn_min']:>7} {str(r['outside_workers_min'] if r['outside_workers_min'] is not None else '-'):>7} "
              f"{str(p.get('anatomy-park','-')):>7} {str(p.get('szechuan-sauce','-')):>6} {str(r['scoped']):<6} "
              f"{sum(r['anatomy_passes'].values()) if r['anatomy_passes'] else '-'}")
    print(f"\n{len(rows)} sessions. Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}. "
          "Numbers only: repo = sha256(working_dir)[:8]; no ticket text or paths.")


if __name__ == "__main__":
    main()
