#!/usr/bin/env python3
"""
护照印章墙 · 国家剪影版 生成器
------------------------------------------------------------
从项目的 web/world.json（Natural Earth 110m）里取真实国界，
投影成 SVG 路径，套进 8 种外框剪影，输出单文件 HTML + 可截图。

用法：
    python3 build-stamps.py            # 用 STAMPS 里的默认国家
改国家：只改下面 STAMPS 列表（中文名要能在 world.json 的 zh/name/alt 里匹配到）。
改外框：改 FRAMES（每个都是一条闭合 path，统一占 y14..88 / x16..84）。
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'web', 'world.json'))
OUT_HTML = os.path.join(HERE, 'passport-stamps-silhouette.html')

# ── 要盖章的国家：(中文名, 城市, 年份, 墨色, 外框key) ──────────────────
STAMPS = [
    ('中国',     'BEIJING',  2016, '#B23A2E', 'seal'),
    ('日本',     'KYOTO',    2018, '#A8474B', 'gable'),
    ('希腊',     'THIRA',    2019, '#2F6FB0', 'scallop'),
    ('美国',     'NEW YORK', 2017, '#2E8B84', 'octagon'),
    ('英国',     'LONDON',   2015, '#C0392B', 'bell'),
    ('法国',     'PARIS',    2014, '#8A6A3B', 'ogee'),
    ('澳大利亚', 'SYDNEY',   2021, '#2C7FB8', 'dome'),
    ('意大利',   'PISA',     2022, '#B4653A', 'circle'),
]

# 群岛国：保留面积 ≥ 最大环 × 该比例 的岛屿环（其余国家只取最大陆块，避免阿拉斯加之类把图拉变形）
RATIO = {'中国': 0.15, '日本': 0.05, '希腊': 0.04, '美国': 0.40,
         '英国': 0.10, '法国': 0.10, '澳大利亚': 0.15, '意大利': 0.10}
DEFAULT_RATIO = 0.15

# 剪影在印章内的可用方框（stamp viewBox 0..100）
BOX = dict(cx=50, cy=40, tw=44, th=33)


def scallop(cx, cy, R, lobes):
    st = 2 * math.pi / lobes; rIn = R * 0.9; rOut = R * 1.08; d = ''
    for i in range(lobes):
        a0 = i * st; a1 = (i + 1) * st; am = (a0 + a1) / 2
        x0 = cx + rIn * math.cos(a0); y0 = cy + rIn * math.sin(a0)
        x1 = cx + rIn * math.cos(a1); y1 = cy + rIn * math.sin(a1)
        xc = cx + rOut * math.cos(am); yc = cy + rOut * math.sin(am)
        if not i:
            d += f"M{x0:.1f} {y0:.1f} "
        d += f"Q{xc:.1f} {yc:.1f} {x1:.1f} {y1:.1f} "
    return d + "Z"


FRAMES = {
    'seal':    'M31 14 H69 Q82 14 82 31 V71 Q82 88 69 88 H31 Q18 88 18 71 V31 Q18 14 31 14 Z',
    'gable':   'M24 88 V42 L50 15 L76 42 V88 Z',
    'scallop': scallop(50, 51, 36, 20),
    'octagon': 'M34 14 H66 L84 32 V70 L66 88 H34 L16 70 V32 Z',
    'bell':    'M26 88 V40 A24 24 0 0 1 74 40 V88 Z',
    'ogee':    'M26 88 V46 C26 30 38 17 50 14 C62 17 74 30 74 46 V88 Z',
    'dome':    'M17 88 V52 A33 33 0 0 1 83 52 V88 Z',
    'circle':  'M50 14 A37 37 0 1 1 50 88 A37 37 0 1 1 50 14 Z',
}


def rings_of(geom):
    if geom['type'] == 'Polygon':
        return geom['coordinates']
    if geom['type'] == 'MultiPolygon':
        return [r for poly in geom['coordinates'] for r in poly]
    return []


def ring_area(r):
    s = 0
    for i in range(len(r) - 1):
        s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return abs(s) / 2


def project(rings):
    lons = [p[0] for r in rings for p in r]
    lats = [p[1] for r in rings for p in r]
    lon0, lat0 = min(lons), min(lats)
    w = (max(lons) - lon0) or 1e-6
    h = (max(lats) - lat0) or 1e-6
    sc = min(BOX['tw'] / w, BOX['th'] / h)
    ox = BOX['cx'] - w * sc / 2
    oy = BOX['cy'] + h * sc / 2          # 纬度向上 → SVG y 向下
    def one(r):
        pts = [f"{(ox + (lo - lon0) * sc):.1f} {(oy - (la - lat0) * sc):.1f}" for lo, la in r]
        return "M" + (" L".join(pts)) + " Z"
    return " ".join(one(r) for r in rings)


def main():
    if not os.path.exists(WORLD):
        sys.exit(f"找不到地图数据: {WORLD}")
    feats = json.load(open(WORLD))['features']
    by = {}
    for f in feats:
        p = f['properties']
        for k in ('zh', 'name'):
            if p.get(k):
                by[p[k]] = f
        for a in (p.get('alt') or []):
            by[a] = f

    sil = {}
    for cn, _, _, _, _ in STAMPS:
        f = by.get(cn)
        if not f:
            print(f"  ! 未找到 {cn}，跳过"); continue
        rings = rings_of(f['geometry'])
        big = max(ring_area(r) for r in rings)
        ratio = RATIO.get(cn, DEFAULT_RATIO)
        keep = [r for r in rings if ring_area(r) >= big * ratio]
        sil[cn] = project(keep)
        print(f"  {cn:>4} {f['properties']['name']:>26}  环 {len(keep)}/{len(rings)}  点 {sum(len(r) for r in keep)}")

    j = lambda s: json.dumps(s, ensure_ascii=False)
    frames_block = "const FRAMES = {\n" + "\n".join(f"  {k}: {j(v)}," for k, v in FRAMES.items()) + "\n};"
    sil_block = "const SIL = {\n" + "\n".join(f"  {j(cn)}: {j(sil[cn])}," for cn in sil) + "\n};"
    data_block = "const DATA = [\n" + "\n".join(
        f"  {{cn:{j(cn)},city:{j(city)},yr:{yr},ink:{j(ink)},frame:{j(fr)}}},"
        for cn, city, yr, ink, fr in STAMPS) + "\n];"

    tpl = open(os.path.join(HERE, 'stamp-template.html'), encoding='utf-8').read()
    html = (tpl.replace('__FRAMES__', frames_block)
               .replace('__SIL__', sil_block)
               .replace('__DATA__', data_block))
    open(OUT_HTML, 'w', encoding='utf-8').write(html)
    print(f"\n✓ 已生成 {OUT_HTML}  ({len(html)} bytes, {len(sil)} 枚印章)")


if __name__ == '__main__':
    main()
