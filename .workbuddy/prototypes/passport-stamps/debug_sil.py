#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, math
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORLD = os.path.join(PROJ, 'web', 'world.json')
RATIO = {'日本': 0.030, '加拿大': 0.055, '意大利': 0.030, '澳大利亚': 0.05,
         '法国': 0.05, '美国': 0.40, '德国': 0.10, '英国': 0.030,
         '西班牙': 0.05, '巴西': 0.04, '瑞典': 0.04, '新西兰': 0.10}

def rings_of(g):
    if g['type'] == 'Polygon': return g['coordinates']
    if g['type'] == 'MultiPolygon': return [r for p in g['coordinates'] for r in p]
    return []
def ring_area(r):
    s=0
    for i in range(len(r)-1): s += r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
    return abs(s)/2
def project(rings, box):
    cx,cy,tw,th = box
    lons=[p[0] for r in rings for p in r]; lats=[p[1] for r in rings for p in r]
    lon0,lat0=min(lons),min(lats); w=(max(lons)-lon0) or 1e-6; h=(max(lats)-lat0) or 1e-6
    sc=min(tw/w,th/h); ox=cx-w*sc/2; oy=cy+h*sc/2
    pts=[(ox+(lo-lon0)*sc, oy-(la-lat0)*sc) for r in rings for lo,la in r]
    return pts

feats=json.load(open(WORLD))['features']
by={}
for f in feats:
    p=f['properties']
    for k in ('zh','name'):
        if p.get(k): by[p[k]]=f
    for a in (p.get('alt') or []): by[a]=f

for zh in ['法国','西班牙','日本']:
    f=by.get(zh)
    if not f: print(zh,'NOT FOUND'); continue
    rings=rings_of(f['geometry'])
    areas=sorted((ring_area(r) for r in rings), reverse=True)
    big=max(areas)
    keep=[r for r in rings if ring_area(r)>=big*RATIO.get(zh,.1)]
    pts=project(keep,(50,49,38,27)) if zh=='法国' else project(keep,(50,49,42,26))
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    print(f"{zh}: rings={len(rings)} kept={len(keep)} biggest={big:.2f} areas_top={areas[:4]}")
    print(f"   bbox x[{min(xs):.1f},{max(xs):.1f}] y[{min(ys):.1f},{max(ys):.1f}]  pts={len(pts)}")
