#!/usr/bin/env python3
"""Renders the Woogles-TV icons from the SVG sources in this folder into the web app and the Android app.

The art uses SVG filters (glow, shadow) and the banner uses the Mulish font, which ImageMagick doesn't render
faithfully, so this draws them in headless Chromium:

    pip install playwright && playwright install chromium
    python3 art/render.py

Sources:  icon.svg (launcher, PWA), favicon.svg (browser tabs: simplified for 16-32 px), maskable.svg (installed web
app, art inside the safe zone), apple.svg (iOS home screen, full bleed) and banner.svg (Android TV home row, 16:9).
The outputs are committed, so this only needs re-running after changing the art.
"""
import base64
import os
import shutil

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = os.path.join(ROOT, 'web/static/fonts/Mulish-400_900.woff2')

JOBS = [  # (source, output, width, height)
    ('icon.svg', 'web/static/wtv2-192.png', 192, 192),
    ('icon.svg', 'web/static/wtv2-512.png', 512, 512),
    ('maskable.svg', 'web/static/wtv2-maskable.png', 512, 512),
    ('apple.svg', 'web/static/wtv2-apple.png', 180, 180),
    ('icon.svg', 'android/res/mipmap-mdpi/ic_launcher.png', 48, 48),
    ('icon.svg', 'android/res/mipmap-hdpi/ic_launcher.png', 72, 72),
    ('icon.svg', 'android/res/mipmap-xhdpi/ic_launcher.png', 96, 96),
    ('icon.svg', 'android/res/mipmap-xxhdpi/ic_launcher.png', 144, 144),
    ('icon.svg', 'android/res/mipmap-xxxhdpi/ic_launcher.png', 192, 192),
    ('banner.svg', 'android/res/drawable/banner.png', 320, 180),
    ('banner.svg', 'android/res/drawable-xhdpi/banner.png', 640, 360),
]


def main():
    font = 'data:font/woff2;base64,' + base64.b64encode(open(FONT, 'rb').read()).decode()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for src, out, w, h in JOBS:
            svg = open(os.path.join(HERE, src)).read().replace('<svg ', f'<svg width="{w}" height="{h}" ', 1)
            page = browser.new_page(viewport={'width': w, 'height': h})
            page.set_content(f'<html><head><style>@font-face{{font-family:Mulish;src:url({font});font-weight:400 900}}'
                             f'body{{margin:0}}</style></head><body>{svg}</body></html>')
            page.evaluate('document.fonts.ready')
            page.wait_for_timeout(200)
            path = os.path.join(ROOT, out)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            page.screenshot(path=path, omit_background=True, clip={'x': 0, 'y': 0, 'width': w, 'height': h})
            page.close()
            print(out)
        browser.close()
    shutil.copy(os.path.join(HERE, 'favicon.svg'), os.path.join(ROOT, 'web/static/wtv2-favicon.svg'))
    print('web/static/wtv2-favicon.svg')


if __name__ == '__main__':
    main()
