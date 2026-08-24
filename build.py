#!/usr/bin/env python3
"""Generate one app per schedule.

index.html is the template. Everything between the DATA markers is one
schedule's own data; everything between the PEERS markers is a busy map for
all three, so any app can work out when the group is free.
"""
import re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / 'index.html'
DATA  = re.compile(r'/\* ==DATA:START== \*/.*?/\* ==DATA:END== \*/', re.S)
PEERS = re.compile(r'/\* ==PEERS:START== \*/.*?/\* ==PEERS:END== \*/', re.S)

MEET = re.compile(r"days:'([MTWRF]+)',\s*start:'(\d\d):(\d\d)',\s*end:'(\d\d):(\d\d)'")
IDENT = re.compile(r"const SCHEDULE = \{ id:'([^']+)', label:'([^']*)' \}")

SOURCES = [('jack', TEMPLATE), ('b', ROOT / 'data' / 'b.js'), ('c', ROOT / 'data' / 'c.js')]


def data_block(path):
    m = DATA.search(Path(path).read_text())
    if not m:
        sys.exit('no DATA block in ' + str(path))
    return m.group(0)


def busy_map(block):
    out = {d: [] for d in 'MTWRF'}
    for days, sh, sm, eh, em in MEET.findall(block):
        s, e = int(sh) * 60 + int(sm), int(eh) * 60 + int(em)
        for d in days:
            if d in out:
                out[d].append([s, e])
    for d in out:
        out[d].sort()
    return out


def peers_block():
    rows = []
    for sid, path in SOURCES:
        block = data_block(path)
        ident = IDENT.search(block)
        label = ident.group(2) if ident else sid
        b = busy_map(block)
        days = ','.join('%s:%s' % (d, str(b[d]).replace(' ', '')) for d in 'MTWRF')
        rows.append("  %s:{ label:'%s', busy:{%s} }" % (sid, label.replace("'", ""), days))
    return '/* ==PEERS:START== */\nconst PEERS = {\n' + ',\n'.join(rows) + '\n};\n/* ==PEERS:END== */'


def build(block, out_html, copy_icon=True):
    tpl = TEMPLATE.read_text()
    if not DATA.search(tpl) or not PEERS.search(tpl):
        sys.exit('template is missing a marker block')
    html = DATA.sub(lambda m: block, tpl, count=1)
    html = PEERS.sub(lambda m: peers_block(), html, count=1)
    out_html.parent.mkdir(parents=True, exist_ok=True)
    out_html.write_text(html)
    if copy_icon:
        shutil.copyfile(ROOT / 'icon.png', out_html.parent / 'icon.png')
    print('built', out_html)


if __name__ == '__main__':
    own = data_block(TEMPLATE)          # read before the template is rewritten
    peers = peers_block()
    build(data_block(ROOT / 'data' / 'b.js'), ROOT / 'b' / 'index.html')
    build(data_block(ROOT / 'data' / 'c.js'), ROOT / 'c' / 'index.html')
    build(own, TEMPLATE, copy_icon=False)   # refresh the peer map in place
