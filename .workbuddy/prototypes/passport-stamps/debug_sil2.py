#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, math
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORLD = os.path.join(PROJ, 'web', 'world.json')
def rings_of(g):
    if g['type']=='Polygon': return g['coordinates']
    if g['type']=='MultiPolygon': return [r for p in g['coordinates'] for r in p]
    return []
def ring_area(r):
    s=0
    for i in range(len(r)-1): s+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
    return abs(s)/2
feats=json.load(open(WORLD))['features']
f=[x for x in feats if x['properties'].get('zh')=='法国'][0]
g=f['geometry']
print("geom type:", g['type'], "top-level coords len:", len(g['coordinates']) if g['type']=='MultiPolygon' else 'n/a')
rings=rings_of(g)
print("num rings:", len(rings))
ar=sorted(((ring_area(r), i) for i,r in enumerate(rings)), reverse=True)
for a,i in ar:
    r=rings[i]
    lons=[p[0] for p in r]; lats=[p[1] for p in r]
    print(f"  ring#{i} area={a:.3f} npts={len(r)} lon[{min(lons):.2f},{max(lons):.2f}] lat[{min(lats):.2f},{max(lats):.2f}]")
# project with box but print per-ring projected bbox
cx,cy,tw,th=(50,49,38,27)
lons=[p[0] for r in rings for p in r]; lats=[p[1] for r in rings for p in r]
lon0,lat0=min(lons),min(lats); w=(max(lons)-lon0) or 1e-6; h=(max(lats)-lat0) or 1e-6
sc=min(tw/w,th/h); ox=cx-w*sc/2; oy=cy+h*sc/2
print(f"combined scale={sc:.3f} ox={ox:.2f} oy={oy:.2f} w={w:.2f} h={h:.2f}")
for i in [ar[0][1], ar[1][1]]:
    r=rings[i]
    xs=[ox+(lo-lon0)*sc for lo,la in r]; ys=[oy-(la-lat0)*sc for lo,la in r]
    print(f"  projected ring#{i}: x[{min(xs):.1f},{max(xs):.1f}] y[{min(ys):.1f},{max(ys):.1f}]")
