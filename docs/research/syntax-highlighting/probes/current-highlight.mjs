// Research-only diagnostic. Run from the repository root:
// node docs/research/syntax-highlighting/probes/current-highlight.mjs
// Uses the installed Pi 1.0.0 and actual terminal cells, not a mock theme.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import hljs from 'highlight.js/lib/core.js';
import { highlightCode, getLanguageFromPath } from '@earendil-works/pi-coding-agent';
import { initTheme, theme } from '../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { renderFileCard } from '../../../../src/file-card.ts';
import { loadAllHighlightLanguages } from '../../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/syntax-highlight.js';
import xterm from '@xterm/headless';
const require = createRequire(import.meta.url);
const { Terminal } = xterm;
initTheme('dark', false);
console.log(JSON.stringify({ eagerHtmlRegistered: !!hljs.getLanguage('html') }));
// Match the normal interactive host after its background language registration.
await loadAllHighlightLanguages();
console.log(JSON.stringify({ node: process.version, pi: require('../../../../node_modules/@earendil-works/pi-coding-agent/package.json').version, highlightjs: require('highlight.js/package.json').version }));
const samples = [
  ['sample.ts', 'const result: User = client.fetch(user.id) ?? fallback;'],
  ['sample.ts', 'interface User { name: string; active: boolean }\nfunction greet(user: User): string { return user.name; }'],
  ['sample.py', 'result = client.fetch(user.id) if user.active else fallback'],
  ['sample.rs', 'let result: User = client.fetch(user.id)?;'],
  ['sample.html', '<button class="primary" onclick="submit()">Save</button>'],
  ['sample.sh', 'npm test && printf "%s\\n" "$HOME" | tee result.txt'],
  ['sample.vue', '<script setup lang="ts">const count = ref(0)</script>'],
];
for (const [path, code] of samples) {
  const lang = getLanguageFromPath(path);
  const ansi = highlightCode(code, lang);
  const reference = new Terminal({ cols: 300, rows: 30, allowProposedApi: true });
  const rendered = new Terminal({ cols: 300, rows: 30, allowProposedApi: true });
  const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
  await write(reference, theme.fg('toolOutput', 'X'));
  const base = reference.buffer.active.getLine(0).getCell(0).getFgColor();
  await write(reference, '\x1b[2J\x1b[H' + theme.fg('toolOutput', ansi.join('\r\n')));
  let ordinary = 0, total = 0;
  const defaultRuns = [];
  for (const [row, text] of code.split('\n').entries()) {
    let run = '';
    for (let col = 0; col < text.length; col++) {
      const cell = reference.buffer.active.getLine(row).getCell(col);
      const same = cell.isFgDefault() || cell.getFgColor() === base;
      if (!/\s/u.test(text[col])) { total++; if (same) ordinary++; }
      if (same) run += text[col];
      else if (run) { defaultRuns.push(run); run = ''; }
    }
    if (run) defaultRuns.push(run);
  }
  const diff = code.split('\n').map((s, i) => `+${i + 1} ${s}`).join('\n');
  const card = renderFileCard({ args: { path }, isPartial: false, result: { details: { diff } } }, undefined, 100, theme,
    (s, p) => highlightCode(s, getLanguageFromPath(p)));
  let comparedCells = 0;
  for (const [index, source] of code.split('\n').entries()) {
    const cardRow = card.rows.find(row => stripVTControlCharacters(row).includes(` ${index + 1} + ${source}`));
    assert.ok(cardRow, 'Complete code row is present in the actual card');
    const offset = stripVTControlCharacters(cardRow).indexOf(source);
    await write(rendered, '\x1b[2J\x1b[H' + cardRow);
    for (let col = 0; col < source.length; col++) {
      assert.equal(rendered.buffer.active.getLine(0).getCell(offset + col).getFgColor(),
        reference.buffer.active.getLine(index).getCell(col).getFgColor(), 'Card preserves Pi foreground');
      comparedCells++;
    }
  }
  console.log(JSON.stringify({ path, lang: lang ?? null, ordinaryOrTerminalDefaultNonWhitespace: ordinary, totalNonWhitespace: total,
    defaultRuns, html: lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : null,
    comparedCells }));
  reference.dispose(); rendered.dispose();
}
console.log(JSON.stringify({ rolesSharingToolOutput: ['syntaxComment', 'syntaxOperator', 'syntaxPunctuation'].filter(role =>
  JSON.stringify(theme.colors[role]) === JSON.stringify(theme.colors.toolOutput)) }));
console.log(JSON.stringify({ pathResolution: Object.fromEntries(['component.vue', 'component.svelte', 'module.mts', 'module.cts', 'main.tsx', 'Dockerfile', 'dockerfile', 'Makefile', 'CMakeLists.txt', '.bashrc', 'script.sh'].map(path => [path, getLanguageFromPath(path) ?? null])) }));

// Disjoint hunks are currently concatenated despite unknown omitted lexical state.
const patch = '@@ -1 +1 @@\n-/* old opening\n+/* new opening\n@@ -20 +20 @@\n-const oldValue = 1;\n+const newValue = 2;';
const streams = [];
renderFileCard({ args: { path: 'gap.ts' }, isPartial: false, result: { details: { patch } } }, undefined, 100, theme,
  (source, path) => { streams.push(source); return highlightCode(source, getLanguageFromPath(path)); });
console.log(JSON.stringify({ disjointHunkStreams: streams,
  limitation: 'A closing comment in omitted lines cannot be recovered; this is not complete-file source.' }));
