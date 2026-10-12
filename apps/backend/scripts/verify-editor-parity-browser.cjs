// Preview/export PIXEL parity for the manual zoom + pan, in a real browser.
//
// Mounts the actual interactive EditPreview (the production component, bundled with Next's own
// webpack) on the canonical EditProject states that verify-editor-trim-zoom-media.cjs exported, seeks
// the real <video> to the same exported seconds, screenshots the canvas, and compares it with the
// exported MP4's frame: where the zoomed picture lies, to the pixel. No backend, database or auth.
//
//   node scripts/verify-editor-trim-zoom-media.cjs      # first: produces the exports + parity-*.json
//   node scripts/verify-editor-parity-browser.cjs [--dir <dir>] [--viewport 390x844|1200x2100]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const dir = path.resolve(arg('dir', path.join(root, '.real-qa-preview/editor-trim-zoom-media')));
const [vw, vh] = arg('viewport', '1200x2100').split('x').map(Number);
const out = path.join(dir, 'browser'); fs.mkdirSync(out, { recursive: true });
const frontend = path.join(root, 'apps/frontend');

// ---- bundle -----------------------------------------------------------------------------------
const loader = path.join(out, 'typescript-loader.cjs');
fs.writeFileSync(loader, `module.exports=function(source){return require(${JSON.stringify(require.resolve('typescript'))}).transpileModule(source,{compilerOptions:{jsx:4,module:99,target:9,esModuleInterop:true}}).outputText;};`);
const entry = path.join(out, 'entry.tsx');
fs.writeFileSync(entry, `import React from 'react';import {createRoot} from 'react-dom/client';
import {EditPreview} from ${JSON.stringify(path.join(frontend, 'src/components/edit-mode/edit-preview.tsx').replaceAll('\\', '/'))};
const q=new URL(location.href).searchParams;
fetch('/parity.json?label='+q.get('label')).then(r=>r.json()).then(({project})=>{
const t=Number(q.get('t')||1);
createRoot(document.getElementById('app')).render(<EditPreview source={project.assets.find(a=>a.role==='SOURCE')} assets={project.assets}
aspectRatio='9:16' reframePolicy={project.settings.reframePolicy} fitBackground={project.settings.fitBackground}
resolvedVisualLayout={project.settings.resolvedVisualLayout} elements={project.elements}
selectedElementId={null} currentPlayheadSec={t} onPlayheadChange={()=>{}} onSelect={()=>{}} onPreviewElements={()=>{}} onCommitTransform={()=>{}}/>);});`);
const cssFile = path.join(out, 'style.css');
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(frontend, 'tailwind.config.ts'),
  '-i', path.join(frontend, 'src/app/globals.css'), '-o', cssFile], { cwd: frontend, stdio: 'pipe' });
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/bundle.js"></script>';
const fixtures = Object.fromEntries(fs.readdirSync(dir).filter((f) => /^parity-.*\.json$/u.test(f))
  .map((f) => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return [j.label, j]; }));
assert(Object.keys(fixtures).length, 'run verify-editor-trim-zoom-media.cjs first');
const fileFor = (asset) => path.join(dir, asset.role === 'SOURCE' ? 'source.mp4' : asset.role === 'AUDIO' ? 'music.wav' : 'overlay.png');
const mimeFor = (asset) => asset.role === 'SOURCE' ? 'video/mp4' : asset.role === 'AUDIO' ? 'audio/wav' : 'image/png';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (file, mime) => {
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    const bytes = fs.readFileSync(file); res.setHeader('Content-Type', mime); res.setHeader('Access-Control-Allow-Origin', '*');
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) { const start = Number(range[1]), end = range[2] ? Number(range[2]) : bytes.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      res.end(bytes.subarray(start, end + 1)); }
    else { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
  };
  if (url.pathname === '/parity.json') return send(path.join(dir, `parity-${url.searchParams.get('label')}.json`), 'application/json');
  if (url.pathname === '/bundle.js') return send(path.join(out, 'bundle.js'), 'application/javascript');
  if (url.pathname === '/style.css') return send(cssFile, 'text/css');
  if (url.pathname.startsWith('/fonts/')) return send(path.join(frontend, 'public', url.pathname), 'font/ttf');
  const media = /\/edit-mode\/assets\/([^/]+)\/file/u.exec(url.pathname);
  if (media) { const asset = Object.values(fixtures).flatMap((f) => f.project.assets).find((a) => a.id === media[1]); return asset ? send(fileFor(asset), mimeFor(asset)) : (res.statusCode = 404, res.end()); }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  res.statusCode = 404; res.end();
});

// ---- comparison -------------------------------------------------------------------------------
const raw = (file, w, h, seek) => execFileSync('ffmpeg', ['-v', 'error', ...(seek !== undefined ? ['-ss', String(seek)] : []), '-i', file,
  ...(seek !== undefined ? ['-frames:v', '1'] : []), '-vf', `scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
const frame = (data, w, h) => ({ width: w, height: h, data });
const pxAt = (f, x, y) => { const i = (y * f.width + x) * 3; return [f.data[i], f.data[i + 1], f.data[i + 2]]; };
function mae(a, b, rect, margin, dx = 0, dy = 0) {
  let total = 0, n = 0;
  for (let y = rect.y + margin; y < rect.y + rect.height - margin; y += 2) for (let x = rect.x + margin; x < rect.x + rect.width - margin; x += 2) {
    const p = pxAt(a, x, y), q = pxAt(b, x + dx, y + dy);
    total += (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3; n++;
  }
  return total / n;
}
function bestShift(a, b, rect, margin, range = 8) {
  let best = { dx: 0, dy: 0, error: Infinity };
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    const error = mae(a, b, rect, margin + range, dx, dy); if (error < best.error) best = { dx, dy, error };
  }
  return best;
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const packaged = require('next/dist/compiled/webpack/webpack'); packaged.init(); const webpack = packaged.webpack;
  await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false, entry, output: { path: out, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js', '.cjs', '.json'], alias: { '@': path.join(frontend, 'src') } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }] },
    plugins: [new webpack.DefinePlugin({ 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(url) })] }, (error, stats) => {
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true }))); else resolve(); }));
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const report = []; let failed = 0;
  try {
    for (const [label, fixture] of Object.entries(fixtures)) {
      const project = fixture.project;
      const layout = project.settings.resolvedVisualLayout;
      const canvasW = 1080, canvasH = 1920;
      // The picture window: the whole canvas, or the card layout's video window.
      const frameBox = layout?.videoFrame?.mode === 'CARD' ? layout.videoFrame : { x: 0, y: 0, width: 1, height: 1 };
      const rect = { x: Math.round(frameBox.x * canvasW), y: Math.round(frameBox.y * canvasH), width: Math.round(frameBox.width * canvasW), height: Math.round(frameBox.height * canvasH) };
      const exportFile = path.join(dir, fixture.export);
      for (const t of fixture.times.filter((value) => value >= 1)) {
        const page = await browser.newPage({ viewport: { width: vw, height: vh } });
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${url}/?label=${label}&t=${t}`);
        await page.waitForFunction(() => document.querySelector('[data-testid="edit-preview-video"]')?.getAttribute('data-media-state') === 'READY', null, { timeout: 60000 });
        await page.waitForFunction((target) => { const v = document.querySelector('video'); return v && v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - target) < 0.15; }, project.elements.find((e) => e.type === 'VIDEO').trimStart + t, { timeout: 60000 });
        await page.waitForTimeout(250);
        const canvas = page.getByTestId('edit-preview-canvas');
        const shot = path.join(out, `${label}-t${t}.png`);
        await canvas.screenshot({ path: shot });
        const box = await canvas.boundingBox();
        const preview = frame(raw(shot, canvasW, canvasH), canvasW, canvasH);
        const exported = frame(raw(exportFile, canvasW, canvasH, t), canvasW, canvasH);
        // Text, captions and overlays are drawn by different engines; compare the VIDEO window only,
        // inside a margin, where only the picture's geometry can differ.
        const inner = { x: rect.x, y: rect.y + (layout ? 0 : 0), width: rect.width, height: rect.height };
        const margin = Math.round(Math.min(inner.width, inner.height) * 0.12);
        const zero = mae(preview, exported, inner, margin), best = bestShift(preview, exported, inner, margin, 8);
        const row = { label, t, canvasCss: { width: Math.round(box.width), height: Math.round(box.height) },
          mae: Number(zero.toFixed(2)), bestShift: { dx: best.dx, dy: best.dy, mae: Number(best.error.toFixed(2)) }, errors };
        // Overlay geometry (an opaque orange image): its pixel bounding box must be the same in both.
        const orange = ([r, g, b]) => r > 200 && g > 110 && g < 170 && b < 60;
        const imgEl = project.elements.find((e) => e.type === 'IMAGE');
        const around = imgEl ? { x0: Math.max(0, imgEl.properties.x * canvasW - 200), x1: Math.min(canvasW, (imgEl.properties.x + imgEl.properties.width) * canvasW + 200),
          y0: Math.max(0, imgEl.properties.y * canvasH - 200), y1: Math.min(canvasH, (imgEl.properties.y + imgEl.properties.height) * canvasH + 200) } : null;
        const bbox = (f) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let y = Math.floor(around?.y0 ?? 0); y < (around?.y1 ?? f.height); y += 1) for (let x = Math.floor(around?.x0 ?? 0); x < (around?.x1 ?? f.width); x += 1) if (orange(pxAt(f, x, y))) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
          return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }; };
        // (Real footage contains orange tones of its own, so the solid-colour box test is for the synthetic fixtures.)
        const imageOn = !label.startsWith('realclip') && project.elements.some((e) => e.type === 'IMAGE' && t >= e.startTime && t < e.startTime + e.duration && (e.properties.opacity ?? 1) >= 0.99);
        let overlay = null; let overlayOk = true;
        if (imageOn) { const a = bbox(preview), b = bbox(exported);
          overlay = { preview: a, export: b };
          overlayOk = !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 4);
          console.log(`       overlay box preview ${JSON.stringify(a)} export ${JSON.stringify(b)} ${overlayOk ? 'MATCH' : 'MISMATCH'}`); }
        row.overlay = overlay;
        const ok = Math.abs(best.dx) <= 2 && Math.abs(best.dy) <= 2 && best.error < 32 && !errors.length && overlayOk;
        if (!ok) failed++;
        report.push({ ...row, ok });
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} t=${t}s preview vs export: best shift (${best.dx},${best.dy}) px at 1080x1920, MAE ${best.error.toFixed(1)}`);
        await page.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'parity-report.json'), JSON.stringify(report, null, 2));
  console.log(failed ? `${failed} parity check(s) FAILED` : 'Preview/export parity: PASS');
  if (failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
