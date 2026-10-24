"""Card matching with one edge per card and per unordered account pair."""
import json, sys
import numpy as np
from scipy.optimize import milp, Bounds, LinearConstraint
from scipy.sparse import coo_matrix, vstack

def solve(data):
    n, edges = data['n'], data['edges']
    if not 0 <= n <= 500 or len(edges) > 20000:
        raise ValueError('capacity_exceeded')
    if not edges:
        return []
    accounts=data['accounts']
    if len(accounts)!=n or any(not isinstance(x,int) or x<0 or x>=n for x in accounts):
        raise ValueError('invalid_accounts')
    groups = {}
    rows, cols = [], []
    for i, e in enumerate(edges):
        if not 0 <= e['a'] < e['b'] < n or accounts[e['a']]==accounts[e['b']] or not 0 <= e['score'] <= 100:
            raise ValueError('invalid_edge')
        group = groups.setdefault(e['owners'], n + len(groups))
        rows.extend([accounts[e['a']], accounts[e['b']], group]); cols.extend([i, i, i])
    m = len(edges)
    matrix = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n+len(groups), m)).tocsc()
    def run(cost, a, lo, hi):
        r = milp(cost, integrality=np.ones(m), bounds=Bounds(0, 1),
                 constraints=LinearConstraint(a, lo, hi),
                 options={'time_limit': 20, 'mip_rel_gap': 0})
        if not r.success or r.status != 0:
            raise RuntimeError('optimal_solution_not_proven')
        return np.rint(r.x).astype(int)
    first = run(-np.ones(m), matrix, np.zeros(matrix.shape[0]), np.ones(matrix.shape[0]))
    count = int(first.sum())
    matrix = vstack([matrix, coo_matrix(np.ones((1, m)))]).tocsc()
    # Fix maximum cardinality, then maximize compatibility. Stable edge order
    # makes repeated previews reproducible; no personal identifiers enter Python.
    scores = [e['score'] + (n//2*100+1 if data.get('requested') in [e['a'],e['b']] else 0) for e in edges]
    chosen = run(-np.array(scores, dtype=float), matrix,
                 np.r_[np.zeros(matrix.shape[0]-1), count], np.r_[np.ones(matrix.shape[0]-1), count])
    return [[e['a'],e['b']] for e,x in zip(edges,chosen) if x]

if __name__ == '__main__':
    print(json.dumps({'pairs': solve(json.load(sys.stdin))}))
