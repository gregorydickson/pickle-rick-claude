"""Add 'core' ranges (hunks carrying code on either side, comment-only hunks dropped) to meta.json."""
import json, build
m = json.load(open(build.S + '/meta.json'))
def code(ls): return any(l.strip() and not l.strip().startswith(('*', '//', '/*')) for l in ls)
build.h_fixed(); ref = {f: build.read(f) for f in {v['file'] for v in build.POOL.values()}}
for name in ('a_whole_k12', 'c_whole_k3'):
    build.variant(m[name]['ids'])
    for i, v in m[name]['loc'].items():
        new = build.read(v['file']); core = []
        for (x, y) in v['ranges']:
            op = [o for o in m[name]['maps'][v['file']] if o[4] != 'equal' and o[2] + 1 == x][0]
            old = ref[v['file']][op[0]:op[1]]; nw = new[op[2]:op[3]]
            if code(old) or code(nw): core.append((x, y))
        v['core'] = core
        print(name, i, v['ranges'], '->', core)
build.restore()
json.dump(m, open(build.S + '/meta.json', 'w'), indent=1)
