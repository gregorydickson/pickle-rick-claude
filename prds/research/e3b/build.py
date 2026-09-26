"""E3b builder: re-introduce real historical defects by reversing their fix commits.

base = 12ffe1327d (first-parent main, 2026-08-28), head = 1ad3f505c3 (2026-09-07).
H_fixed = head + forward-apply of the pool fixes that landed AFTER head (D1, D2, D9).
Variant(k) = H_fixed + reverse-apply of the chosen fixes. Reviewed diff = base..variant, extension/src,
CLAUDE.md excluded, each +/context line prefixed with its post-image line number (as E3).
"""
import json, subprocess, os, re, difflib
S = os.path.dirname(os.path.abspath(__file__)); WT = S + '/wt'
BASE = '12ffe1327d9f326620f13d5ed621dec680181d1a'
HEAD = '1ad3f505c31ec6ec231c489b9482b36777fbcea6'
POOL = json.load(open(S + '/pool.json'))          # id -> {sha, file, after_head}
ORDER = sorted(POOL, key=lambda i: -POOL[i]['pos'])  # reverse newest fix first
C_SUBSET = ['D1', 'D11', 'D2']                      # random.seed(20260926); random.sample(ids, 3)
SCOPE = ['extension/src', ':!*CLAUDE.md']

def git(*a, **k):
    return subprocess.run(['git', '-C', WT, *a], capture_output=True, text=True, check=True, **k).stdout

def patch(i):
    return f"{S}/fix_{POOL[i]['sha'][:10]}.patch"

def restore():
    git('checkout', '-q', '--', 'extension')

def h_fixed():
    restore()
    for i in POOL:
        if POOL[i]['after_head']:
            git('apply', patch(i))

def variant(ids):
    h_fixed()
    for i in ORDER:
        if i in ids:
            git('apply', '-R', patch(i))

def read(f):
    return open(f'{WT}/{f}').read().split('\n')

def numbered(paths):
    d = git('diff', '-U3', BASE, '--', *paths, ':!*CLAUDE.md')
    out = []; n = 0
    for l in d.split('\n'):
        h = re.match(r'^@@ -(\d+)(?:,\d+)? \+(\d+)', l)
        if h: n = int(h[2]); out.append(l); continue
        if l.startswith(('diff ', 'index ', '--- ', '+++ ', 'new file', 'deleted file', 'similarity', 'rename', 'old mode', 'new mode', '\\')):
            out.append(l); continue
        if l.startswith('+'): out.append(f'{n:>5} +{l[1:]}'); n += 1
        elif l.startswith('-'): out.append(f'      -{l[1:]}')
        elif l.startswith(' '): out.append(f'{n:>5}  {l[1:]}'); n += 1
        else: out.append(l)
    return '\n'.join(out)

def changed_files():
    return [f for f in git('diff', '--name-only', BASE, '--', *SCOPE).split('\n') if f]

def lane_of(f, lanes):
    best = None
    for ln in lanes:
        d = ln['dir']
        if (f == d or f.startswith(d + '/')) and not any(f == x or f.startswith(x + '/') for x in ln['excludes']):
            if best is None or len(d) > len(best['dir']): best = ln
    return best['name'] if best else None

def locate(ids):
    """Post-image line ranges of each active defect in variant(ids), plus an H_fixed->variant line map per file."""
    h_fixed(); ref = {f: read(f) for f in {POOL[i]['file'] for i in POOL}}
    single = {}
    for i in ids:  # old-side (H_fixed) ranges of each defect alone
        h_fixed(); git('apply', '-R', patch(i)); f = POOL[i]['file']
        sm = difflib.SequenceMatcher(None, ref[f], read(f), autojunk=False)
        single[i] = [(a1, a2) for t, a1, a2, b1, b2 in sm.get_opcodes() if t != 'equal']
    variant(ids); loc = {}; maps = {}
    for f in ref:
        new = read(f); sm = difflib.SequenceMatcher(None, ref[f], new, autojunk=False)
        ops = sm.get_opcodes(); maps[f] = [(a1, a2, b1, b2, t) for t, a1, a2, b1, b2 in ops]
        for i in ids:
            if POOL[i]['file'] != f: continue
            rs = []
            for t, a1, a2, b1, b2 in ops:
                if t == 'equal': continue
                for (s1, s2) in single[i]:
                    if a1 <= s2 and s1 <= a2:
                        rs.append((b1 + 1, max(b2, b1 + 1))); break
            loc[i] = dict(file=f, ranges=rs, defect_lines=[l for (x, y) in rs for l in new[x - 1:y]])
    return loc, maps

if __name__ == '__main__':
    lanes = json.load(open(S + '/lanes.json'))
    os.makedirs(S + '/diffs', exist_ok=True)
    meta = {}
    specs = {'a_whole_k12': list(POOL), 'c_whole_k3': C_SUBSET, 'x_whole_k0': []}
    for name, ids in specs.items():
        loc, maps = locate(ids) if ids else ({}, {})
        variant(ids)
        files = changed_files()
        open(f'{S}/diffs/{name}.diff', 'w').write(numbered(files))
        meta[name] = dict(ids=ids, loc=loc, maps=maps)
        if name == 'a_whole_k12':
            by = {}
            for f in files: by.setdefault(lane_of(f, lanes), []).append(f)
            for ln, fs in sorted(by.items()):
                tag = 'b_' + ln.replace('extension/', '').replace('/.', '_root').replace('/', '_')
                open(f'{S}/diffs/{tag}_k12.diff', 'w').write(numbered(fs))
                meta.setdefault('lanes', {})[tag] = dict(lane=ln, files=fs)
    json.dump(meta, open(S + '/meta.json', 'w'), indent=1)
    restore(); print(git('status', '--short') or 'worktree clean')
