import json,subprocess,sys,os,re
S=os.path.dirname(os.path.abspath(__file__)); WT=S+'/wt'; B='f36ea11ea20ebe5e4b6efdb43b924321c575f9b7'
M=json.load(open(S+'/mutations.json'))
PARTS={'bin':['extension/src/bin'],'services':['extension/src/services','extension/src/lib'],
       'hooks':['extension/src/hooks','extension/src/types'],'tests':['extension/tests']}
ALL=sum(PARTS.values(),[])
def apply(ids):
    for m in M:
        if m['id'] not in ids: continue
        p=f"{WT}/{m['file']}"; L=open(p).read().split('\n'); ln=L[m['line']-1]
        assert ln.count(m['orig'])==1,(m['id'],ln); L[m['line']-1]=ln.replace(m['orig'],m['mut']); open(p,'w').write('\n'.join(L))
def restore():
    subprocess.run(['git','-C',WT,'checkout','--','extension'],check=True)
def numbered(paths):
    d=subprocess.run(['git','-C',WT,'diff','-U3',B,'--',*paths,':!*CLAUDE.md'],capture_output=True,text=True,check=True).stdout
    out=[];o=n=0
    for l in d.split('\n'):
        h=re.match(r'^@@ -(\d+)(?:,\d+)? \+(\d+)',l)
        if h: o,n=int(h[1]),int(h[2]); out.append(l); continue
        if l.startswith(('diff ','index ','--- ','+++ ','new file','deleted file','similarity','rename','old mode','new mode','\\')): out.append(l); continue
        if l.startswith('+'): out.append(f'{n:>5} +{l[1:]}'); n+=1
        elif l.startswith('-'): out.append(f'      -{l[1:]}'); o+=1
        elif l.startswith(' '): out.append(f'{n:>5}  {l[1:]}'); n+=1; o+=1
        else: out.append(l)
    return '\n'.join(out)
restore()
apply({m['id'] for m in M})
os.makedirs(S+'/diffs',exist_ok=True)
open(S+'/diffs/a_whole_k20.diff','w').write(numbered(ALL))
for k,v in PARTS.items(): open(S+f'/diffs/b_{k}_k20.diff','w').write(numbered(v))
restore(); apply({'B1','B2','B5','H4','T3'})
open(S+'/diffs/c_whole_k5.diff','w').write(numbered(ALL))
restore()
subprocess.run(['git','-C',WT,'status','--short'])
