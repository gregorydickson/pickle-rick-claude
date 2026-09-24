import json,re,glob,os,statistics as st
S=os.path.dirname(os.path.abspath(__file__))
M=json.load(open(S+'/mutations.json')); C={'B1','B2','B5','H4','T3'}
def norm(s): return re.sub(r'\s+','',s or '')
def load(name):
    d=json.load(open(f'{S}/raw/{name}.json'))
    meta={k:d.get(k) for k in ['subtype','is_error','num_turns','total_cost_usd','duration_ms']}
    t=d.get('result','').strip(); t=re.sub(r'^```(json)?|```$','',t.strip()).strip()
    try: f=json.loads(t[t.index('['):t.rindex(']')+1])
    except Exception as e: meta['parse_error']=str(e); f=[]
    meta['usage_in']=d.get('usage',{}).get('input_tokens',0)+d.get('usage',{}).get('cache_read_input_tokens',0)+d.get('usage',{}).get('cache_creation_input_tokens',0)
    return f,meta
def match(fd,m,active):
    fp=(fd.get('file') or '').lstrip('./')
    same=fp.endswith(m['file']) or m['file'].endswith(fp) and fp!=''
    try: ln=int(fd.get('line'))
    except: ln=-99
    blob=norm(fd.get('quote',''))+norm(fd.get('bug',''))+norm(fd.get('title',''))
    code=m['mut'] if active else m['orig']
    return same and (abs(ln-m['line'])<=3 or norm(code) in blob)
def score(findings, active_ids):
    act=[m for m in M if m['id'] in active_ids]
    found=set(); fps=[]
    for fd in findings:
        hits=[m['id'] for m in act if match(fd,m,True)]
        found|=set(hits)
        if not hits: fps.append(fd)
    return found,fps
rows={}; detail={}
for arm,active in [('a',{m['id'] for m in M}),('b',{m['id'] for m in M}),('c',C)]:
    for r in (1,2,3):
        if arm=='b':
            fs=[];metas=[]
            for p in ['bin','services','hooks','tests']:
                f,meta=load(f'b_{p}_k20_r{r}'); fs+=f; metas.append(meta)
        else:
            fs,meta=load(f"{'a_whole_k20' if arm=='a' else 'c_whole_k5'}_r{r}"); metas=[meta]
        found,fps=score(fs,active)
        rows.setdefault(arm,[]).append(dict(k=len(active),found=len(found),recall=len(found)/len(active),nfind=len(fs),fp=len(fps),ids=sorted(found),metas=metas))
        detail[f'{arm}_r{r}']=dict(found=sorted(found),fps=[{k:x.get(k) for k in ['file','line','severity','conf','title']} for x in fps])
json.dump(dict(rows=rows,detail=detail),open(S+'/scores.json','w'),indent=1)
for arm,rs in rows.items():
    print(arm, [ (x['found'],x['nfind'],x['fp']) for x in rs], 'recall mean %.3f'%st.mean(x['recall'] for x in rs),
          'found mean %.2f'%st.mean(x['found'] for x in rs),'fp mean %.2f'%st.mean(x['fp'] for x in rs))
    for x in rs: print('   ',x['ids'], [ (m.get('is_error'),m.get('num_turns'),m.get('parse_error'),m.get('usage_in')) for m in x['metas']])
# per-mutation hit counts
from collections import Counter
for arm in rows:
    c=Counter(i for x in rows[arm] for i in x['ids']); print(arm,dict(sorted(c.items())))
