#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复古世界旅行邮戳 · 生成器
对标 web/assets/复古世界旅行邮戳合集.png：
  双线外框 + 弧排英文国名 + EST. YYYY + 实心国界剪影 + 左右专属饰件 + 做旧斑点
素材全部由代码生成（国界取自 web/world.json = Natural Earth 110m）。
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORLD = os.path.join(PROJ, 'web', 'world.json')
OUT = os.path.join(HERE, 'postmarks.html')

CX, CY = 50.0, 50.0

# ── 12 枚：英文名 / 中文名 / EST / 墨色(取样自参考图) / 外框 / 左右饰件 ──
STAMPS = [
    ('JAPAN',          '日本',   1868, '#1E6FB4', 'oval',    'waves'),
    ('CANADA',         '加拿大', 1867, '#CE4B3C', 'tri',     'maple'),
    ('ITALY',          '意大利', 1861, '#63764A', 'rsquare', 'star'),
    ('AUSTRALIA',      '澳大利亚',1901, '#7E5287', 'circle',  'star3'),
    ('FRANCE',         '法国',    843, '#8C654A', 'scallop', 'fleur'),
    ('UNITED STATES',  '美国',   1776, '#1B8FA0', 'rrect',   'star'),
    ('GERMANY',        '德国',   1871, '#D2961C', 'circle',  'laurel'),
    ('UNITED KINGDOM', '英国',   1707, '#C24C5C', 'hex',     'crown'),
    ('SPAIN',          '西班牙', 1492, '#DD7730', 'oval2',   'cancel'),
    ('BRAZIL',         '巴西',   1822, '#984A77', 'rsquare', 'star'),
    ('SWEDEN',         '瑞典',   1523, '#36608E', 'circle',  'tree'),
    ('NEW ZEALAND',    '新西兰', 1907, '#4F6F47', 'perf',    'fern'),
]

RATIO = {'日本': 0.030, '加拿大': 0.055, '意大利': 0.030, '澳大利亚': 0.05,
         '法国': 0.05, '美国': 0.40, '德国': 0.10, '英国': 0.030,
         '西班牙': 0.05, '巴西': 0.04, '瑞典': 0.04, '新西兰': 0.10}

TILT = [2.2, -2.8, 1.8, -1.6, -2.4, 2.6, -1.4, 2.0, -2.6, 1.6, 2.8, -1.8]


# ══════════════ 外框几何 ══════════════
def ellipse(rx, ry):
    return (f"M{CX-rx:.2f} {CY:.2f} A{rx:.2f} {ry:.2f} 0 1 0 {CX+rx:.2f} {CY:.2f} "
            f"A{rx:.2f} {ry:.2f} 0 1 0 {CX-rx:.2f} {CY:.2f} Z")

def rrect(x, y, w, h, r):
    return (f"M{x+r:.2f} {y:.2f} H{x+w-r:.2f} A{r:.2f} {r:.2f} 0 0 1 {x+w:.2f} {y+r:.2f} "
            f"V{y+h-r:.2f} A{r:.2f} {r:.2f} 0 0 1 {x+w-r:.2f} {y+h:.2f} H{x+r:.2f} "
            f"A{r:.2f} {r:.2f} 0 0 1 {x:.2f} {y+h-r:.2f} V{y+r:.2f} "
            f"A{r:.2f} {r:.2f} 0 0 1 {x+r:.2f} {y:.2f} Z")

def scallop(R, lobes, bump=0.045):
    rIn, rOut = R * (1 - bump), R * (1 + bump * 0.5)
    d = ''
    for i in range(lobes):
        a0, a1 = i * 2 * math.pi / lobes, (i + 1) * 2 * math.pi / lobes
        am = (a0 + a1) / 2
        p0 = (CX + rIn * math.cos(a0), CY + rIn * math.sin(a0))
        p1 = (CX + rIn * math.cos(a1), CY + rIn * math.sin(a1))
        pm = (CX + rOut * math.cos(am), CY + rOut * math.sin(am))
        if not i:
            d += f"M{p0[0]:.2f} {p0[1]:.2f} "
        d += f"Q{pm[0]:.2f} {pm[1]:.2f} {p1[0]:.2f} {p1[1]:.2f} "
    return d + "Z"

def perforated(x0, y0, x1, y1, r=2.05, spacing=7.4):
    def notch(lo, hi):
        n = max(2, int(round((hi - lo) / spacing)))
        s = (hi - lo) / n
        return [lo + s * (i + 0.5) for i in range(n)]
    d = f"M{x0:.2f} {y0:.2f} "
    for xc in notch(x0, x1):
        d += f"L{xc-r:.2f} {y0:.2f} A{r:.2f} {r:.2f} 0 0 0 {xc+r:.2f} {y0:.2f} "
    d += f"L{x1:.2f} {y0:.2f} "
    for yc in notch(y0, y1):
        d += f"L{x1:.2f} {yc-r:.2f} A{r:.2f} {r:.2f} 0 0 0 {x1:.2f} {yc+r:.2f} "
    d += f"L{x1:.2f} {y1:.2f} "
    for xc in reversed(notch(x0, x1)):
        d += f"L{xc+r:.2f} {y1:.2f} A{r:.2f} {r:.2f} 0 0 0 {xc-r:.2f} {y1:.2f} "
    d += f"L{x0:.2f} {y1:.2f} "
    for yc in reversed(notch(y0, y1)):
        d += f"L{x0:.2f} {yc+r:.2f} A{r:.2f} {r:.2f} 0 0 0 {x0:.2f} {yc-r:.2f} "
    return d + f"L{x0:.2f} {y0:.2f} Z"


# frame: d() 外轮廓; Rx/Ry 外半径; 文字模式; sil 剪影框; nw/ew 名字与EST目标宽; nh 名字最大字高
FRAMES = {
    'oval':    dict(d=lambda: ellipse(42.5, 32.5), Rx=42.5, Ry=32.5, mode='arc',
                    sil=(50, 48.5, 42, 26), nw=46, ew=24, nh=9.5),
    'oval2':   dict(d=lambda: ellipse(43, 31.5),   Rx=43,   Ry=31.5, mode='arc',
                    sil=(50, 48.5, 43, 25), nw=46, ew=24, nh=9.5),
    'circle':  dict(d=lambda: ellipse(39.5, 39.5), Rx=39.5, Ry=39.5, mode='arc',
                    sil=(50, 49, 40, 27), nw=48, ew=23, nh=9.5),
    'scallop': dict(d=lambda: scallop(38.5, 26, 0.055), Rx=38.5, Ry=38.5, mode='arc',
                    sil=(50, 49, 38, 27), nw=40, ew=22, nh=9.5),
    'rsquare': dict(d=lambda: rrect(13, 13, 74, 74, 7), mode='line', ty=32, byy=79,
                    nw=40, ew=21, nh=10, sil=(50, 49, 46, 30)),
    'rrect':   dict(d=lambda: rrect(7, 24, 86, 52, 9), mode='line', ty=38, byy=68,
                    nw=70, ew=30, nh=10.5, sil=(50, 49.5, 58, 25)),
    'tri':     dict(d=lambda: 'M50 9 L91 90 L9 90 Z', mode='line', ty=34, byy=82,
                    nw=36, ew=22, nh=10, sil=(50, 57, 40, 26)),
    'hex':     dict(d=lambda: 'M31 10 L69 10 L88 45 L69 90 L31 90 L12 45 Z', mode='line', ty=35, byy=79,
                    nw=56, ew=24, nh=8.6, sil=(50, 52, 40, 30)),
    'perf':    dict(d=lambda: perforated(12, 12, 88, 88), mode='line', ty=30, byy=80,
                    nw=54, ew=26, nh=9.5, sil=(50, 51, 50, 32)),
}


# ══════════════ 饰件 ══════════════
def _star(cx, cy, r=3.2):
    pts = []
    for i in range(10):
        a = -90 + i * 36
        rr = r if i % 2 == 0 else r * 0.44
        pts.append(f"{cx+rr*math.cos(math.radians(a)):.2f} {cy+rr*math.sin(math.radians(a)):.2f}")
    return f'<path d="M{" L".join(pts)} Z" class="of"/>'

def waves(x, y, flip=False):
    sgn = -1 if flip else 1
    out = []
    for i in range(3):
        yy = y - 4 + i * 4
        d = f"M{x:.1f} {yy:.1f} q2.3 -1.7 4.6 0 t4.6 0 t4.6 0"
        out.append(f'<path d="{d}" class="ol"/>')
    return ''.join(out)

def maple(x, y, s=1.0):
    d = ("M0 -5.6 L1.8 -2.5 L4.4 -3.3 L3.3 -0.6 L6.0 0.3 L3.7 1.6 L4.3 3.7 "
         "L1.4 2.8 L1.1 6.0 L0 4.3 L-1.1 6.0 L-1.4 2.8 L-4.3 3.7 L-3.7 1.6 "
         "L-6.0 0.3 L-3.3 -0.6 L-4.4 -3.3 L-1.8 -2.5 Z")
    return f'<g transform="translate({x:.1f} {y:.1f}) scale({s})"><path d="{d}" class="of"/></g>'

def fleur(x, y, s=1.0):
    d = ("M0 -6.4 C1.7 -4.4 1.9 -2.3 0.7 -0.7 C3.1 -2.3 5.1 -1.5 5.3 0.5 "
         "C3.6 -0.2 2.0 0.3 0.7 1.8 L-0.7 1.8 C-2.0 0.3 -3.6 -0.2 -5.3 0.5 "
         "C-5.1 -1.5 -3.1 -2.3 -0.7 -0.7 C-1.9 -2.3 -1.7 -4.4 0 -6.4 Z")
    return (f'<g transform="translate({x:.1f} {y:.1f}) scale({s})">'
            f'<path d="{d}" class="of"/>'
            f'<path d="M-1.9 2.0 H1.9 L1.6 3.3 H-1.6 Z" class="of"/>'
            f'<path d="M0 2.0 V6.2" class="ol"/></g>')

def crown(x, y, s=1.0):
    body = "M-5.4 2.5 L-4.4 -3.6 L-2.4 0.6 L0 -4.7 L2.4 0.6 L4.4 -3.6 L5.4 2.5 Z"
    pip = "".join(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="0.9" class="of"/>'
                  for px, py in [(-4.4, -3.9), (0, -5.0), (4.4, -3.9)])
    return (f'<g transform="translate({x:.1f} {y:.1f}) scale({s})">'
            f'<path d="{body}" class="of"/>'
            f'<path d="M-5.4 2.5 H5.4 V4.5 H-5.4 Z" class="of"/>{pip}</g>')

def laurel(x, y, flip=False, s=1.0):
    fs = -1 if flip else 1
    g = [f'<g transform="translate({x:.1f} {y:.1f}) scale({fs*s:.3f} {s:.3f})">']
    g.append('<path d="M1.0 10.0 C-2.3 5.6 -3.4 0.3 -1.6 -6.0" class="ol"/>')
    for i in range(6):
        t = i / 5
        bx = 1.0 + (-1.6 - 1.0) * t - 1.7 * math.sin(math.pi * t) * 0.5
        by = 10.0 + (-6.0 - 10.0) * t
        ang = -56 + i * 3
        g.append(f'<g transform="translate({bx:.2f} {by:.2f}) rotate({ang})">'
                 f'<path d="M0 0 C1.8 -1.6 3.8 -1.2 4.6 0 C3.8 1.2 1.8 1.6 0 0 Z" class="of"/></g>')
        g.append(f'<g transform="translate({bx:.2f} {by:.2f}) rotate({ang+152})">'
                 f'<path d="M0 0 C1.5 -1.3 3.1 -1.0 3.8 0 C3.1 1.0 1.5 1.3 0 0 Z" class="of"/></g>')
    return ''.join(g) + '</g>'

def trees(x, y, s=1.0):
    def one(tx, ty, k):
        return (f'<g transform="translate({tx:.2f} {ty:.2f}) scale({k:.2f})">'
                f'<path d="M0 -6.6 L3.0 -1.0 H-3.0 Z" class="of"/>'
                f'<path d="M0 -3.6 L3.7 2.2 H-3.7 Z" class="of"/>'
                f'<path d="M0 2.2 V4.6" class="ol"/></g>')
    return one(x, y, s) + one(x, y + 8.6, s * 0.78)

def fern(x, y, flip=False, s=1.0):
    fs = -1 if flip else 1
    g = [f'<g transform="translate({x:.1f} {y:.1f}) scale({fs*s:.3f} {s:.3f})">']
    g.append('<path d="M0 9.2 C-1.3 3.0 -1.5 -2.6 0.7 -8.8" class="ol"/>')
    for i in range(7):
        t = (i + 0.5) / 7
        bx = -1.3 * t + 2.0 * t * t
        by = 9.2 + (-8.8 - 9.2) * t
        L = 4.8 * (1 - 0.55 * t)
        g.append(f'<g transform="translate({bx:.2f} {by:.2f}) rotate({-50 + i*3})">'
                 f'<path d="M0 0 C{L*0.45:.2f} -{L*0.40:.2f} {L:.2f} -{L*0.28:.2f} {L:.2f} 0 '
                 f'C{L:.2f} {L*0.28:.2f} {L*0.45:.2f} {L*0.40:.2f} 0 0 Z" class="of"/></g>')
        g.append(f'<g transform="translate({bx:.2f} {by:.2f}) rotate({130 + i*3})">'
                 f'<path d="M0 0 C{L*0.40:.2f} -{L*0.36:.2f} {L*0.86:.2f} -{L*0.25:.2f} {L*0.86:.2f} 0 '
                 f'C{L*0.86:.2f} {L*0.25:.2f} {L*0.40:.2f} {L*0.36:.2f} 0 0 Z" class="of"/></g>')
    return ''.join(g) + '</g>'

def cancel(x, y, flip=False):
    out = []
    for i in range(4):
        yy = y - 5.4 + i * 3.6
        L = 16 - i * 1.5
        x0 = x if not flip else x - L
        out.append(f'<path d="M{x0:.1f} {yy:.1f} h{L:.1f}" class="ol"/>')
    return ''.join(out)

ORNAMENTS = {
    'waves':  lambda: waves(22.5, 56) + waves(77.5, 56, flip=True),
    'maple':  lambda: maple(35.0, 67, 1.05) + maple(65.0, 67, 1.05),
    'star':   lambda: _star(20.5, 54) + _star(79.5, 54),
    'star3':  lambda: (_star(19.5, 46, 2.5) + _star(17.8, 55, 2.8) + _star(20.2, 64, 2.4)
                       + _star(80.5, 46, 2.5) + _star(82.2, 55, 2.8) + _star(79.8, 64, 2.4)),
    'fleur':  lambda: fleur(20.5, 55, 0.95) + fleur(79.5, 55, 0.95),
    'laurel': lambda: laurel(20.5, 48) + laurel(79.5, 48, flip=True),
    'crown':  lambda: crown(22.5, 56, 1.0) + crown(77.5, 56, 1.0),
    'cancel': lambda: cancel(7.5, 55) + cancel(92.5, 55, flip=True),
    'tree':   lambda: trees(21.5, 49, 1.0) + trees(78.5, 49, 1.0),
    'fern':   lambda: fern(24, 54) + fern(76, 54, flip=True),
}


# ══════════════ 国界剪影 ══════════════
def rings_of(g):
    if g['type'] == 'Polygon':
        return g['coordinates']
    if g['type'] == 'MultiPolygon':
        return [r for p in g['coordinates'] for r in p]
    return []

def ring_area(r):
    s = 0
    for i in range(len(r) - 1):
        s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return abs(s) / 2

def bbox_of(r):
    lons = [p[0] for p in r]; lats = [p[1] for p in r]
    return (min(lons), min(lats), max(lons), max(lats))

def project(rings, box):
    cx, cy, tw, th = box
    lons = [p[0] for r in rings for p in r]
    lats = [p[1] for r in rings for p in r]
    lon0, lat0 = min(lons), min(lats)
    w = (max(lons) - lon0) or 1e-6
    h = (max(lats) - lat0) or 1e-6
    sc = min(tw / w, th / h)
    ox = cx - w * sc / 2
    oy = cy + h * sc / 2
    def one(r):
        pts = [f"{(ox+(lo-lon0)*sc):.1f} {(oy-(la-lat0)*sc):.1f}" for lo, la in r]
        return "M" + (" L".join(pts)) + " Z"
    return " ".join(one(r) for r in rings)


# ══════════════ 组装 ══════════════
def arc_path(rx, ry, a0, a1, sweep):
    def pt(a):
        return (CX + rx * math.cos(math.radians(a)), CY + ry * math.sin(math.radians(a)))
    x0, y0 = pt(a0); x1, y1 = pt(a1)
    return f"M{x0:.2f} {y0:.2f} A{rx:.2f} {ry:.2f} 0 0 {sweep} {x1:.2f} {y1:.2f}"

def fit(text, target_w, cap, ls_ratio=0.13, cw=0.60):
    """选字号：让自然宽度 ≈ target_w 的 96%，并由 textLength 保证最终一定贴合"""
    k = len(text) * cw + (len(text) - 1) * ls_ratio
    return max(4.6, min(cap, target_w / k * 0.96))

def main():
    feats = json.load(open(WORLD))['features']
    by = {}
    for f in feats:
        p = f['properties']
        for k in ('zh', 'name'):
            if p.get(k):
                by[p[k]] = f
        for a in (p.get('alt') or []):
            by[a] = f

    cards = []
    for i, (en, zh, est, ink, frame, orn) in enumerate(STAMPS):
        F = FRAMES[frame]
        outer = F['d']()
        seed = 4 + i * 9
        fid, tido = f'f{i}', f't{i}'
        P = [f'<svg viewBox="0 0 100 100" class="stamp-svg">']
        P.append(f'''<defs>
<filter id="{fid}" x="-14%" y="-14%" width="128%" height="128%">
  <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" seed="{seed}" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="3" seed="{seed+5}" result="n2"/>
  <feColorMatrix in="n2" type="luminanceToAlpha" result="a"/>
  <feComponentTransfer in="a" result="am"><feFuncA type="discrete" tableValues="0 0 1 1 1 1 1 1 1 1 1 1"/></feComponentTransfer>
  <feComposite in="d" in2="am" operator="in"/>
</filter></defs>''')
        P.append(f'<g filter="url(#{fid})">')
        # 纸底 + 粗外框
        P.append(f'<path d="{outer}" class="paper" stroke="{ink}" stroke-width="3.4"/>')
        # 细内框（整体缩 0.885）
        inner_d = rrect(18, 18, 64, 64, 2.5) if frame == 'perf' else outer
        P.append(f'<path d="{inner_d}" transform="translate({CX} {CY}) scale(.885) translate({-CX} {-CY})" '
                 f'class="ofr" stroke="{ink}" stroke-width="1.6"/>')
        # 国界剪影
        f = by.get(zh)
        if f:
            rings = rings_of(f['geometry'])
            big = max(ring_area(r) for r in rings)
            main = max(rings, key=ring_area)
            mb = bbox_of(main)
            mw, mh = mb[2] - mb[0], mb[3] - mb[1]
            ex = 0.55                      # 仅保留紧邻本土的环（剔除法属圭亚那等海外飞地）
            def near(r):
                rb = bbox_of(r)
                return not (rb[2] < mb[0] - ex * mw or rb[0] > mb[2] + ex * mw
                            or rb[3] < mb[1] - ex * mh or rb[1] > mb[3] + ex * mh)
            keep = [r for r in rings
                    if ring_area(r) >= big * RATIO.get(zh, .1) and near(r)]
            if not keep:
                keep = [main]
            P.append(f'<path d="{project(keep, F["sil"])}" fill="{ink}" stroke="{ink}" '
                     f'stroke-width="0.6" fill-opacity="0.92"/>')
        # 饰件
        P.append(f'<g stroke="{ink}" fill="{ink}">{ORNAMENTS[orn]()}</g>')

        # ── 文字 ──
        if F['mode'] == 'arc':
            Rx, Ry = F['Rx'], F['Ry']
            # 顶弧：基线靠内，字形朝外；可用弧长
            rx_t, ry_t = Rx * 0.665, Ry * 0.665
            alen_t = math.radians(140) * (rx_t + ry_t) / 2
            tw_t = alen_t * 0.90
            fs_t = fit(en, tw_t, cap=0.26 * (Rx + Ry) / 2)
            ls_t = fs_t * 0.15
            # 底弧：基线靠外，字形朝内
            rx_b, ry_b = Rx * 0.875, Ry * 0.875
            alen_b = math.radians(136) * (rx_b + ry_b) / 2
            tw_b = alen_b * 0.80
            et = f'EST. {est}'
            fs_b = fit(et, tw_b, cap=0.12 * (Rx + Ry) / 2)
            ls_b = fs_b * 0.17
            P.append(f'<defs><path id="{tido}a" d="{arc_path(rx_t, ry_t, 199, 341, 1)}"/>'
                     f'<path id="{tido}b" d="{arc_path(rx_b, ry_b, 158, 22, 0)}"/></defs>')
            P.append(f'<text class="nm" font-size="{fs_t:.2f}" letter-spacing="{ls_t:.2f}" fill="{ink}" '
                     f'textLength="{tw_t:.2f}" lengthAdjust="spacing"><textPath href="#{tido}a" '
                     f'startOffset="50%" text-anchor="middle">{en}</textPath></text>')
            P.append(f'<text class="nm" font-size="{fs_b:.2f}" letter-spacing="{ls_b:.2f}" fill="{ink}" '
                     f'textLength="{tw_b:.2f}" lengthAdjust="spacing"><textPath href="#{tido}b" '
                     f'startOffset="50%" text-anchor="middle">{et}</textPath></text>')
        else:
            tw = F['nw']                 # 名字目标宽
            fs_t = fit(en, tw, cap=F['nh'])
            P.append(f'<text class="nm" x="50" y="{F["ty"]}" font-size="{fs_t:.2f}" fill="{ink}" '
                     f'text-anchor="middle" textLength="{tw:.2f}" lengthAdjust="spacing">{en}</text>')
            et = f'EST. {est}'
            twn = F['ew']                # EST 目标宽
            fs_b = fit(et, twn, cap=8.2)
            P.append(f'<text class="nm" x="50" y="{F["byy"]}" font-size="{fs_b:.2f}" fill="{ink}" '
                     f'text-anchor="middle" textLength="{twn:.2f}" lengthAdjust="spacing">{et}</text>')
        P.append('</g></svg>')
        cards.append(f'<div class="stamp" style="transform:rotate({TILT[i]}deg)">{"".join(P)}</div>')

    html = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>复古世界旅行邮戳 · 12 枚</title><style>
  *{{box-sizing:border-box;}}
  body{{margin:0;background:#eee8dc;}}
  .wrap{{max-width:1040px;margin:0 auto;padding:34px 24px 46px;}}
  .grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:30px 22px;}}
  .stamp{{aspect-ratio:1;display:grid;place-items:center;filter:drop-shadow(0 3px 4px rgba(84,66,44,.22));}}
  .stamp-svg{{width:100%;height:100%;}}
  .nm{{font-family:Georgia,"Times New Roman",serif;font-weight:700;}}
  .paper{{fill:#fcfaf4;stroke-linejoin:round;stroke-linecap:round;}}
  .ofr{{fill:none;stroke-linejoin:round;stroke-linecap:round;}}
  .of{{stroke:none;}}
  .ol{{fill:none;stroke-width:1.3;stroke-linecap:round;}}
</style></head><body><div class="wrap"><div class="grid">
{''.join(cards)}
</div></div></body></html>'''
    open(OUT, 'w', encoding='utf-8').write(html)
    print(f"✓ {OUT} ({len(html)} bytes, {len(cards)} 枚)")

if __name__ == '__main__':
    main()
