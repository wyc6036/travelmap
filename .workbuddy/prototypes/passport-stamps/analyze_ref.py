#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析参考图：4x3 共 12 枚邮戳，逐格测墨色中位数与墨迹覆盖率。"""
from PIL import Image

REF = '/Users/wyc/Documents/da_Project/Docker/travelmap/web/assets/复古世界旅行邮戳合集.png'
im = Image.open(REF).convert('RGB')
W, H = im.size
print(f"size={W}x{H}")
px = im.load()

def classify(r, g, b):
    # 墨色判定：与纯白相比，max 通道明显偏低且对比足够
    mx, mn = max(r, g, b), min(r, g, b)
    if mx < 215 and (mx - mn) / max(mx, 1) > 0.16:
        return True
    return False

cols, rows = 4, 3
cw, ch = W / cols, H / rows
for ri in range(rows):
    for ci in range(cols):
        x0, y0 = int(ci * cw), int(ri * ch)
        x1, y1 = int((ci + 1) * cw), int((ri + 1) * ch)
        # 留边，避免格间白缝
        ix0, iy0 = x0 + int(cw * 0.06), y0 + int(ch * 0.06)
        ix1, iy1 = x1 - int(cw * 0.06), y1 - int(ch * 0.06)
        ink = 0
        tot = 0
        rs = gs = bs = 0
        k = 0
        for y in range(iy0, iy1, 2):
            for x in range(ix0, ix1, 2):
                r, g, b = px[x, y]
                tot += 1
                if classify(r, g, b):
                    ink += 1
                    rs += r; gs += g; bs += b
                    k += 1
        cov = ink / tot if tot else 0
        if k:
            print(f"cell({ri},{ci}) cov={cov*100:5.1f}% ink_rgb=({rs//k},{gs//k},{bs//k})")
        else:
            print(f"cell({ri},{ci}) cov={cov*100:5.1f}% ink=NONE")
