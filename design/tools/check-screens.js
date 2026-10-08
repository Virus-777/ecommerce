#!/usr/bin/env node
/*
  Prototype checker.
  Usage: node design/tools/check-screens.js <path-to-lucide.min.js> [screen-file.js ...]
  1. Verifies every Lucide icon name used in the prototype JS exists in lucide@0.460.0.
  2. Loads core + data + the given screen files in a fake DOM-less sandbox and calls
     every registered screen's render() for each state, reporting exceptions.
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [lucidePath, ...files] = process.argv.slice(2);
if (!lucidePath) { console.error('Pass the path to lucide.min.js'); process.exit(2); }
const root = path.join(__dirname, '..', 'prototype', 'js');
const targets = files.length ? files : fs.readdirSync(path.join(root, 'screens')).map((f) => path.join(root, 'screens', f));

// ---- 1. Icon names ----
const sb = { window: {}, self: {}, globalThis: {} };
sb.self = sb.window; sb.globalThis = sb.window;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(lucidePath, 'utf8'), sb);
const lucide = sb.window.lucide || sb.lucide;
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])([0-9])/g, '$1-$2').toLowerCase();
const known = new Set(Object.keys(lucide.icons).map(kebab));
const pattern = /(?:icon\(|iconBtn\(|icon:\s*|img\(|empty\(|ic:\s*|data-lucide=")\s*['"]([a-z][a-z0-9-]*)['"]/g;
let bad = 0;
for (const f of [path.join(root, 'core.js'), path.join(root, 'data.js'), path.join(root, 'shell.js'), ...targets]) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    let m; pattern.lastIndex = 0;
    while ((m = pattern.exec(line))) {
      if (!known.has(m[1])) { bad++; console.log(`ICON  ${path.relative(process.cwd(), f)}:${i + 1}  "${m[1]}" is not a lucide@0.460.0 icon`); }
    }
  });
}

// ---- 2. Render every screen ----
const noop = () => {};
const fakeEl = () => ({ dataset: {}, style: {}, setAttribute: noop, appendChild: noop, textContent: '' });
const ctx = { console, document: { createElement: fakeEl, head: { appendChild: noop } }, location: { hash: '' } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of [path.join(root, 'core.js'), path.join(root, 'data.js'), ...targets]) {
  try { vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); }
  catch (e) { bad++; console.log(`LOAD  ${path.relative(process.cwd(), f)}: ${e.message}`); }
}
const UI = ctx.UI;
const catalogue = new Set(Object.values(UI.CATALOGUE).flat().flatMap(([, ids]) => ids));
let rendered = 0;
for (const [id, s] of Object.entries(UI.screens)) {
  if (!catalogue.has(id)) { console.log(`ID    "${id}" is registered but not in UI.CATALOGUE`); bad++; }
  for (const st of (s.states && s.states.length ? s.states : [null])) {
    try {
      const html = s.render(st);
      if (typeof html !== 'string' || html.length < 50) throw new Error('render() returned no HTML');
      if (/undefined|NaN|\[object Object\]/.test(html.replace(/javascript:void 0/g, ''))) {
        const m = html.match(/.{0,60}(undefined|NaN|\[object Object\]).{0,40}/);
        console.log(`TEXT  ${id}${st ? ' @' + st : ''}: suspicious output …${m ? m[0] : ''}…`); bad++;
      }
      rendered++;
    } catch (e) { bad++; console.log(`ERROR ${id}${st ? ' @' + st : ''}: ${e.message}`); }
  }
}
const missing = [...catalogue].filter((id) => !UI.screens[id]);
console.log(`\nRendered ${rendered} screen states. ${bad ? bad + ' problem(s).' : 'No problems.'}`);
if (files.length === 0) console.log(`Screens not yet designed (${missing.length}): ${missing.join(', ') || 'none'}`);
process.exit(bad ? 1 : 0);
