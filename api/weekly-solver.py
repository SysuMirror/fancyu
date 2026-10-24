"""Exact general-graph matching. Input contains graph indices and weights only."""
import json,sys,hashlib
import networkx as nx

def solve(data):
    n=data['n']; k=n//2
    if not isinstance(n,int) or not 0<=n<=500: raise ValueError('unsupported graph size')
    g=nx.Graph();g.add_nodes_from(range(n))
    for edge in data['edges']:
        a,b=edge['a'],edge['b']
        if not (0<=a<b<n): raise ValueError('invalid edge')
        score=int(edge['score']); fairness=int(edge.get('fairness',0))
        if not (0<=score<=10000 and 0<=fairness<=104): raise ValueError('invalid weight')
        tie=int.from_bytes(hashlib.sha256(f"{data['seed']}:{a}:{b}".encode()).digest()[:2],'big')%1024
        # Each higher level dominates the sum of all possible lower-level weights.
        weight=((int(bool(edge['preferred']))*(k*10000+1)+score)*(k*104+1)+fairness)*(k*1023+1)+tie
        g.add_edge(a,b,weight=weight)
    return sorted(sorted(p) for p in nx.max_weight_matching(g,maxcardinality=True))

if __name__=='__main__':
    print(json.dumps({'pairs':solve(json.load(sys.stdin))}))
