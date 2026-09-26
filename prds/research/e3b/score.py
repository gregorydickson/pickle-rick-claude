"""E3b scorer. A defect is found when a finding names its file and lands within +/-5 lines of one of
its code-bearing reverted hunks ('core' ranges in meta.json), or quotes one of that hunk's code lines.
False positives = findings matching no active defect, minus findings matching the k=0 control."""
import json, re, os, statistics as st
from collections import Counter
S = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(S + '/meta.json'))
LANES = ['b_src_bin_k12', 'b_src_services_k12', 'b_src_root_k12']
TOL = 5

def norm(s): return re.sub(r'\s+', '', s or '')

def load(name):
    d = json.load(open(f'{S}/raw/{name}.json'))
    meta = {k: d.get(k) for k in ['subtype', 'is_error', 'num_turns', 'total_cost_usd', 'duration_ms']}
    t = (d.get('result') or '').strip(); t = re.sub(r'^```(json)?|```$', '', t).strip()
    try: f = json.loads(t[t.index('['):t.rindex(']') + 1])
    except Exception as e: meta['parse_error'] = str(e); f = []
    return f, meta

def same_file(fd, f):
    fp = (fd.get('file') or '').lstrip('./')
    return fp != '' and (fp.endswith(f) or f.endswith(fp))

def match(fd, loc):
    if not same_file(fd, loc['file']): return False
    try: ln = int(fd.get('line'))
    except (TypeError, ValueError): ln = -99
    if any(x - TOL <= ln <= y + TOL for x, y in loc['core']): return True
    q = norm(fd.get('quote'))
    lines = [norm(l) for l in loc['defect_lines']]
    return any(len(l) >= 15 and l in q for l in lines)

CONTROL = load('x_whole_k0_r1')[0]

def is_control(fd):  # control findings live in H_fixed coordinates; match by file + quote
    return any(same_file(fd, c.get('file', '')) and norm(c.get('quote')) and norm(c.get('quote')) in norm(fd.get('quote')) for c in CONTROL)

def score(findings, loc):
    found = set(); fps = []; ctrl = 0
    for fd in findings:
        hits = [i for i, v in loc.items() if match(fd, v)]
        found |= set(hits)
        if not hits:
            if is_control(fd): ctrl += 1
            else: fps.append(fd)
    return found, fps, ctrl

if __name__ == '__main__':
    rows = {}; detail = {}
    for arm, var in [('a', 'a_whole_k12'), ('b', 'a_whole_k12'), ('c', 'c_whole_k3')]:
        loc = M[var]['loc']
        for r in (1, 2, 3):
            names = [f'{n}_r{r}' for n in LANES] if arm == 'b' else [f'{var}_r{r}']
            fs = []; metas = []; per_call = []
            for n in names:
                f, meta = load(n); fs += f; metas.append(meta)
                per_call.append(len(score(f, loc)[0]))
            found, fps, ctrl = score(fs, loc)
            rows.setdefault(arm, []).append(dict(k=len(loc), found=len(found), recall=len(found) / len(loc), per_call=per_call,
                                                 nfind=len(fs), fp=len(fps), ctrl=ctrl, ids=sorted(found, key=lambda s: int(s[1:])), metas=metas))
            detail[f'{arm}_r{r}'] = dict(found=sorted(found), fps=[{k: x.get(k) for k in ['file', 'line', 'severity', 'conf', 'title']} for x in fps])
    json.dump(dict(control=CONTROL, rows=rows, detail=detail), open(S + '/scores.json', 'w'), indent=1)
    for arm, rs in rows.items():
        rec = [x['recall'] for x in rs]
        print(f"{arm} recall {[round(v, 3) for v in rec]} mean {st.mean(rec):.3f} range {min(rec):.3f}-{max(rec):.3f} | found {[x['found'] for x in rs]} per-call {[x['per_call'] for x in rs]} | findings {[x['nfind'] for x in rs]} FP {[x['fp'] for x in rs]} ctrl {[x['ctrl'] for x in rs]}")
        for x in rs: print('   ', x['ids'], [(m.get('is_error'), m.get('num_turns'), m.get('parse_error'), round(m.get('total_cost_usd') or 0, 2), (m.get('duration_ms') or 0) // 1000) for m in x['metas']])
        print('   per-defect', dict(sorted(Counter(i for x in rs for i in x['ids']).items(), key=lambda kv: int(kv[0][1:]))))
