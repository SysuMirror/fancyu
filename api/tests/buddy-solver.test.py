import importlib.util, pathlib, random
spec=importlib.util.spec_from_file_location('buddy',pathlib.Path(__file__).parents[1]/'buddy-solver.py')
buddy=importlib.util.module_from_spec(spec);spec.loader.exec_module(buddy)

def objective(chosen, data):
    edges={tuple((e['a'],e['b'])):e for e in data['edges']}
    return len(chosen),int(any(data['requested'] in p for p in chosen)),sum(edges[tuple(p)]['score'] for p in chosen)

def brute(data):
    best=(0,0,0)
    def visit(i,used,pairs):
        nonlocal best
        best=max(best,objective(pairs,data))
        for j in range(i,len(data['edges'])):
            e=data['edges'][j];a,b=data['accounts'][e['a']],data['accounts'][e['b']]
            if a in used or b in used:continue
            visit(j+1,used|{a,b},pairs+[[e['a'],e['b']]])
    visit(0,set(),[])
    return best

rng=random.Random(1125)
for n in range(2,10):
    for trial in range(12):
        accounts=[rng.randrange(max(2,n//2)) for _ in range(n)]
        edges=[{'a':a,'b':b,'owners':':'.join(map(str,sorted([accounts[a],accounts[b]]))),'score':rng.randrange(101)} for a in range(n) for b in range(a+1,n) if accounts[a]!=accounts[b] and rng.random()<.6]
        d={'n':n,'accounts':accounts,'edges':edges,'requested':rng.randrange(n)}
        result=buddy.solve(d)
        assert objective(result,d)==brute(d),(d,result,brute(d))
        used=[accounts[i] for pair in result for i in pair]
        assert len(used)==len(set(used))

d={'n':4,'accounts':[0,1,2,3],'requested':0,'edges':[{'a':0,'b':1,'owners':'0:1','score':100},{'a':0,'b':2,'owners':'0:2','score':1},{'a':1,'b':3,'owners':'1:3','score':1}]}
assert len(buddy.solve(d))==2
print('PASS: 96 graphs match exhaustive optimum; account quota, requested card, scores, greedy counterexample.')
