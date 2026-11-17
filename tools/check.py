import asyncio, json, os, re, subprocess, sys, time
from playwright.async_api import async_playwright
ROOT = sys.argv[1]
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = 'http://localhost:8765/'
FLUID = 'accordion acoustic_bass acoustic_guitar_steel banjo brass_section bright_acoustic_piano clavinet contrabass distortion_guitar electric_guitar_jazz fiddle fretless_bass overdriven_guitar pad_2_warm string_ensemble_1 tuba'.split()
async def main():
    ok = True
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for lang in ['he','en','ar','ru','fr','es','de','it']:
            ctx = await b.new_context()
            page = await ctx.new_page()
            errs, ext = [], set()
            page.on('console', lambda m: m.type == 'error' and errs.append(m.text))
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.on('request', lambda r: (not r.url.startswith(BASE) and not r.url.startswith('data:') and not r.url.startswith('blob:')) and ext.add(r.url.split('?')[0]))
            await page.goto(BASE)
            await page.evaluate("l => localStorage.setItem('mapat-settings', JSON.stringify({lang: l}))", lang)
            await page.reload(); await page.wait_for_timeout(1500)
            fonts = await page.evaluate("""async () => { await document.fonts.ready;
               return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight) }""")
            heb = await page.evaluate("() => (document.body.innerText.match(/[\\u0590-\\u05FF]+/g) || []).filter(w => w !== 'עברית')")
            line = f"{lang}: errors={len(errs)} external={sorted(ext)} fonts_loaded={len(set(fonts))}"
            if lang not in ('he',): line += f" hebrew_left={heb[:5]}"
            print(line)
            for e in errs[:5]: print('   ERR', e[:200])
            if errs or ext or (lang != 'he' and heb): ok = False
            if lang == 'he':
                print('   fonts:', sorted(set(fonts)))
                res = await page.evaluate("""async names => { const out = {};
                  for (const n of names) { await new Promise(r => { const s = document.createElement('script'); s.src = 'sounds/fluidr3/' + n + '-mp3.js'; s.onload = s.onerror = r; document.head.appendChild(s); });
                    out[n] = !!(window.MIDI && MIDI.Soundfont && MIDI.Soundfont[n] && Object.keys(MIDI.Soundfont[n]).length > 30); } return out; }""", FLUID)
                bad = [k for k, v in res.items() if not v]; print('   fluidr3 files ok:', len(res) - len(bad), '/', len(res), bad)
                if bad: ok = False
                await page.wait_for_timeout(3000)
                sw = await page.evaluate("""async () => { const reg = await navigator.serviceWorker.getRegistration(); if (!reg) return 'no sw';
                   await navigator.serviceWorker.ready; const ks = await caches.keys(); const c = await caches.open(ks.find(k => k.endsWith('-shell')));
                   const n = (await c.keys()).length; return ks.join(',') + ' shell entries=' + n; }""")
                print('   sw:', sw)
                ver = re.search(r"VERSION = '([^']+)'", open(os.path.join(ROOT, 'sw.js')).read()).group(1)
                if ver not in sw: ok = False
            await ctx.close()
        await b.close()
    print('ALL OK' if ok else 'PROBLEMS')
asyncio.run(main()); srv.terminate()
