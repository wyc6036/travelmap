#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""France 单独渲染：raw(无做旧) vs aged(有做旧)，排查中心墨迹低的原因。"""
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
def project(rings, box):
    cx,cy,tw,th=box
    lons=[p[0] for r in rings for p in r]; lats=[p[1] for r in rings for p in r]
    lon0,lat0=min(lons),min(lats); w=(max(lons)-lon0) or 1e-6; h=(max(lats)-lat0) or 1e-6
    sc=min(tw/w,th/h); ox=cx-w*sc/2; oy=cy+h*sc/2
    return " ".join("M"+" L".join(f"{(ox+(lo-lon0)*sc):.1f} {(oy-(la-lat0)*sc):.1f}" for lo,la in r)+" Z" for r in rings)

feats=json.load(open(WORLD))['features']
f=[x for x in feats if x['properties'].get('zh')=='法国'][0]
rings=rings_of(f['geometry']); big=max(ring_area(r) for r in rings)
keep=[r for r in rings if ring_area(r)>=big*0.05]
sil=project(keep,(50,49,38,27))
print("FRANCE path len:", len(sil))
print(sil[:400])

def page(filter_on):
    filt = '' if not filter_on else '''<defs><filter id="fa" x="-14%" y="-14%" width="128%" height="128%">
  <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" seed="40" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="3" seed="45" result="n2"/>
  <feColorMatrix in="n2" type="luminanceToAlpha" result="a"/>
  <feComponentTransfer in="a" result="am"><feFuncA type="discrete" tableValues="0 0 1 1 1 1 1 1 1 1 1 1 1"/></feComponentTransfer>
  <feComposite in="d" in2="am" operator="in"/></filter></defs>'''
    g = f'<g {"filter=\"url(#fa)\"" if filter_on else ""}>'
    body = (f'<path d="{sil}" fill="#8C654A" stroke="#8C654A" stroke-width="0.6" fill-opacity="0.92"/>')
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{{margin:0;background:#fff}}</style></head>
<body><svg viewBox="0 0 100 100" width="300" height="300">{filt}{g}{body}</g></svg></body></html>'''

for on in (False, True):
    open(f'/tmp/fr_{on}.html','w').write(page(on))
    print("wrote", f'/tmp/fr_{on}.html')
