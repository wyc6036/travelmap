#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测渲染后每枚邮戳的墨迹覆盖率，并分区域（外环=框 / 中心=剪影）检查结构。"""
from PIL import Image
import os

DIR = '/tmp/pm_stamps'
names = ['JAPAN','CANADA','ITALY','AUSTRALIA','FRANCE','UNITED STATES',
         'GERMANY','UNITED KINGDOM','SPAIN','BRAZIL','SWEDEN','NEW ZEALAND']

def classify(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    lum = 0.2126*r + 0.7152*g + 0.0722*b
    return lum < 235 and (mx - mn) / max(mx, 1) > 0.12

def cov_of(im, x0, y0, x1, y1):
    px = im.load()
    ink = tot = 0
    for y in range(y0, y1, 2):
        for x in range(x0, x1, 2):
            r, g, b = px[x, y]
            tot += 1
            if classify(r, g, b):
                ink += 1
    return ink / tot if tot else 0

for i, nm in enumerate(names):
    p = os.path.join(DIR, f's{i}.png')
    if not os.path.exists(p):
        print(f"{nm}: MISSING"); continue
    im = Image.open(p).convert('RGB')
    W, H = im.size
    # 去边 12% 避开 drop-shadow
    mx0, my0 = int(W*0.12), int(H*0.12)
    mx1, my1 = int(W*0.88), int(H*0.88)
    tot = cov_of(im, mx0, my0, mx1, my1)
    # 外环区：四边条带（占边 12%~26%）
    ring_top = cov_of(im, mx0, my0, mx1, int(H*0.26))
    ring_bot = cov_of(im, mx0, int(H*0.74), mx1, my1)
    ring_l = cov_of(im, mx0, my0, int(W*0.26), my1)
    ring_r = cov_of(im, int(W*0.74), my0, mx1, my1)
    ring = (ring_top+ring_bot+ring_l+ring_r)/4
    # 中心区：中间 48%
    c0 = int(W*0.26); c1 = int(W*0.74)
    center = cov_of(im, c0, c0, c1, c1)
    print(f"{nm:14s} total={tot*100:5.1f}%  ring={ring*100:5.1f}%  center={center*100:5.1f}%")
