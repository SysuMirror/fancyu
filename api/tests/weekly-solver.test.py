import importlib.util, pathlib, random, hashlib
p=pathlib.Path(__file__).resolve().parents[1]/'weekly-solver.py'
spec=importlib.util.spec_from_file_location('solver',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def objective(pairs,edges,seed):
    by={(e['a'],e['b']):e for e in edges};result=[len(pairs),0,0,0,0]
    for pair in pairs:
        a,b=sorted(pair);e=by[a,b];result[1]+=e['preferred'];result[2]+=e['score'];result[3]+=e['fairness'];result[4]+=int.from_bytes(hashlib.sha256(f'{seed}:{a}:{b}'.encode()).digest()[:2],'big')%1024
    return tuple(result)
def brute(nodes,edges,seed):
    if not nodes:return []
    a=nodes[0];best=brute(nodes[1:],edges,seed)
    for e in edges:
        if e['a']==a and e['b'] in nodes:
            candidate=[[a,e['b']]]+brute([n for n in nodes[1:] if n!=e['b']],edges,seed)
            if objective(candidate,edges,seed)>objective(best,edges,seed):best=candidate
    return best
rng=random.Random(123)
for n in range(2,10):
    for _ in range(12):
        edges=[dict(a=a,b=b,score=rng.randint(0,10000),preferred=rng.choice([True,False]),fairness=rng.randint(0,104)) for a in range(n) for b in range(a+1,n) if rng.random()<.55]
        data=dict(n=n,edges=edges,seed='fixed');actual=m.solve(data)
        assert objective(actual,edges,'fixed')==objective(brute(list(range(n)),edges,'fixed'),edges,'fixed')
        assert actual==m.solve(data)
edges=[dict(a=a,b=b,score=s,preferred=t,fairness=0) for a,b,s,t in [(0,1,9999,True),(0,2,100,False),(1,3,100,False)]]
assert len(m.solve(dict(n=4,edges=edges,seed='test')))==2
print('PASS: 96 general graphs matched exhaustive lexicographic optimum; deterministic ties; cardinality beats high-score single pair.')
