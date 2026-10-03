// Real bundled CLI tests. Every capture is produced during this test run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import xterm from '@xterm/headless';
import { getInstalledIntegrationProfile } from './fixtures/integration-profile.mjs';

const { Terminal } = xterm;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.PI_TEST_CLI || 'pi';
const extension = join(root, 'src/index.ts');
const fixtures = join(root, 'tests/fixtures');
const artifacts = join(root, '.test-artifacts', `terminal-${Date.now()}-${process.pid}`);
mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const plain = (line) => stripVTControlCharacters(line).trimEnd();
const lines = (tool) => tool.lines.map(plain).filter((line) => line.trim());
const byName = (dump, name) => dump.tools.filter((tool) => tool.name === name);
const nativeTiming = (value) => value.replace(/Took \d+(?:\.\d+)?s/g, 'Took <runtime>s');
const toolLines = (dump) => dump.tools.map(({ name, lines }) => ({ name, lines: lines.map(nativeTiming) }));
async function assertFits(rows, width) {
  const terminal = new Terminal({ cols: width, rows: 4, allowProposedApi: true });
  try {
    for (const row of rows) {
      assert.ok(!/[\r\n]/.test(row), 'component row cannot contain a line break');
      terminal.reset();
      await new Promise((done) => terminal.write(row, done));
      assert.equal(terminal.buffer.active.cursorY, 0, `row must not wrap at ${width} columns`);
    }
  } finally { terminal.dispose(); }
}

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(30);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}; artifacts: ${artifacts}`);
}

export class PiTerminal {
  // The integration-profile helper may supply additional isolated settings, environment and explicit extensions.
  constructor(name, { toolview = false, mode = 'fullscreen', session, flags = [],
    agentSettings = {}, extraEnv = {}, extensions = [], workspace, profileFactory } = {}) {
    this.output = join(artifacts, name);
    mkdirSync(this.output);
    this.temp = mkdtempSync(join(tmpdir(), 'pi-toolview-terminal-'));
    this.work = workspace || join(this.temp, 'work');
    this.agent = join(this.temp, 'agent');
    mkdirSync(this.work, { recursive: true }); mkdirSync(this.agent);
    this.profile = profileFactory?.({ homeDir: this.temp, agentDir: this.agent, workDir: this.work,
      provider: 'toolview-offline', model: 'scripted' });
    for (const file of this.profile?.configFiles || []) {
      const path = resolve(file.path);
      assert.ok(path.startsWith(this.temp + '/'), 'profile config must remain inside the fresh test home');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    if (this.profile) writeFileSync(join(this.output, 'integration-profile.json'), JSON.stringify(this.profile, null, 2));
    if (!session) rmSync(join(this.work, 'written.txt'), { force: true });
    writeFileSync(join(this.work, 'a.txt'), 'READ_A_CONTENT\n');
    writeFileSync(join(this.work, 'b.txt'), 'READ_B_CONTENT\n');
    writeFileSync(join(this.work, 'abcdefghijklm'), 'BOUNDARY_READ_CONTENT\n');
    mkdirSync(join(this.work, 'long-directory'), { recursive: true });
    writeFileSync(join(this.work, 'long-directory', 'r'.repeat(180) + '.txt'), 'LONG_READ_CONTENT\n');
    writeFileSync(join(this.work, 'pixel.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
    writeFileSync(join(this.agent, 'settings.json'), JSON.stringify({
      theme: 'dark', quietStartup: true, ...this.profile?.settings, ...agentSettings,
      enableAnalytics: false, enableInstallTelemetry: false,
    }));
    this.term = new Terminal({ cols: 100, rows: 80, scrollback: 3000, allowProposedApi: true });
    this.raw = [];
    this.queue = Promise.resolve();
    this.lastOutput = Date.now();
    const args = ['-ns', '-np', '-nc', '-na', '--offline', '-e', join(fixtures, 'driver.ts')];
    if (!this.profile) args.unshift('-ne', '--no-themes');
    for (const path of extensions) args.push('-e', resolve(path));
    if (toolview) args.push('-e', extension);
    args.push('--model', 'toolview-offline/scripted', '--tui-mode', mode, ...flags);
    if (session) args.push('--session', session);
    const env = this.profile ? { ...this.profile.env, TOOLVIEW_TEST_OUTPUT: this.output, TOOLVIEW_TEST_PROFILE: 'installed' } : {
      ...extraEnv,
      PATH: process.env.PATH, HOME: this.temp, XDG_CONFIG_HOME: join(this.temp, 'config'),
      XDG_CACHE_HOME: join(this.temp, 'cache'), XDG_DATA_HOME: join(this.temp, 'data'),
      TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
      PI_CODING_AGENT_DIR: this.agent, TOOLVIEW_TEST_OUTPUT: this.output,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
    this.child = spawn('python3', [join(fixtures, 'pty_bridge.py'), '100', '80', this.work, cli, ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => { this.error = error; });
    this.child.stdin.on('error', (error) => { if (!this.closing) this.error = error; });
    this.stderr = '';
    this.child.stderr.on('data', (data) => { this.stderr += data; });
    this.child.on('exit', (code, signal) => { this.exited = { code, signal }; });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.error) this.error = new Error(frame.error);
        if (frame.data) {
          const data = Buffer.from(frame.data, 'base64');
          this.raw.push(data);
          this.lastOutput = Date.now();
          this.queue = this.queue.then(() => new Promise((done) => this.term.write(data, done)));
        }
        if (frame.exit !== undefined && !this.closing) this.error = new Error(`Pi exited: ${frame.exit}`);
      } catch (error) { this.error = error; }
    });
    // Let the terminal emulator answer native cursor/device queries, just as a terminal would.
    this.term.onData((data) => this.send(data));
    writeFileSync(join(this.output, 'invocation.json'), JSON.stringify({ cli, args, mode, work: this.work }, null, 2));
  }
  send(data) {
    if (!this.closing && this.child.stdin.writable) {
      this.lastOutput = Date.now();
      this.child.stdin.write(JSON.stringify({ input: Buffer.from(data).toString('base64') }) + '\n');
    }
  }
  health() {
    if (this.error || this.exited) throw this.error || new Error(`Bridge exited ${JSON.stringify(this.exited)}: ${this.stderr}`);
  }
  events() {
    this.health();
    try {
      return readFileSync(join(this.output, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async event(type, count = 1) {
    return until(() => this.events().filter((event) => event.type === type).length >= count, `${type} #${count}`);
  }
  async ready() {
    await this.event('start');
    assert.equal(this.events().find((event) => event.type === 'start').sharedContainer, true);
    await this.settle();
  }
  async settle(animated = false) {
    if (animated) {
      // A running Pi spinner deliberately never becomes idle. Sample after a render interval.
      await sleep(220); this.health();
    } else {
      await until(() => { this.health(); return Date.now() - this.lastOutput >= 160; }, 'terminal idle');
    }
    await this.queue;
  }
  async command(command) {
    this.send(command + '\r');
    await this.settle();
  }
  screen() {
    const buffer = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
  }
  async capture(name, { animated = false } = {}) {
    this.send(`/tv-dump ${name}\r`);
    const dump = await until(() => {
      this.health();
      try { return JSON.parse(readFileSync(join(this.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `live capture ${name}`);
    await this.settle(animated);
    this.session = dump.session;
    const screen = this.screen();
    writeFileSync(join(this.output, `${name}.screen.txt`), screen.join('\n'));
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    const buffer = this.term.buffer.active;
    const cells = screen.map((_, y) => Array.from({ length: this.term.cols }, (_, x) => {
      const cell = buffer.getLine(buffer.viewportY + y)?.getCell(x);
      return cell ? { text: cell.getChars(), width: cell.getWidth(),
        fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() } : null;
    }));
    writeFileSync(join(this.output, `${name}.screen.json`), JSON.stringify(cells));
    return { ...dump, screen, cells };
  }
  async run(scenario = 'suite') {
    const count = this.events().filter((e) => e.type === 'agent_end').length;
    this.send(`run ${scenario}\r`);
    await this.event('agent_end', count + 1);
    await this.settle();
    assert.ok(this.screen().some((line) => line.includes(`TERMINAL_DONE_${scenario}`)));
  }
  async resize(cols, rows = 80) {
    this.term.resize(cols, rows);
    this.child.stdin.write(JSON.stringify({ resize: [cols, rows] }) + '\n');
    await sleep(80);
    await this.settle();
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    writeFileSync(join(this.output, 'bridge.stderr'), this.stderr);
    if (this.session && existsSync(this.session)) copyFileSync(this.session, join(this.output, 'session.jsonl'));
    if (existsSync(join(this.work, 'written.txt')))
      copyFileSync(join(this.work, 'written.txt'), join(this.output, 'written.txt'));
    if (!this.exited) {
      const done = once(this.child, 'exit');
      this.child.stdin.end('{"stop":true}\n');
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 2500);
      let deadline;
      try { await Promise.race([done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Bridge cleanup timeout')), 5500);
      })]); }
      finally { clearTimeout(timer); clearTimeout(deadline); }
    }
    this.rl.close(); this.term.dispose();
  }
  dispose() { rmSync(this.temp, { recursive: true, force: true }); }
}

function execution(terminal) {
  const events = terminal.events();
  assert.equal(events.filter((e) => e.type === 'call').length, 7);
  assert.equal(events.filter((e) => e.type === 'result').length, 7);
  assert.equal(events.filter((e) => e.type === 'model_context').length, 8);
  return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
}
function persisted(dump) {
  return dump.branch.filter((e) => e.type === 'message').flatMap(({ message }) => {
    if (message.role === 'toolResult') return [{ role: message.role, toolName: message.toolName,
      content: message.content, details: message.details, isError: message.isError }];
    if (message.role === 'assistant') return message.content.filter((c) => c.type === 'toolCall')
      .map(({ name, arguments: args }) => ({ name, arguments: args }));
    return [];
  });
}
// Separators are not content rows. Recover logical text without relying on a one-row preview.
const summaryText = (tool) => lines(tool).map((row) => row.slice(3)).join('').replace(/\s/gu, '');
const summaryExpected = (value) => value.replace(/\s/gu, '');
function compactContent(tool) {
  const rows = lines(tool);
  assert.ok(rows.length > 0, `compact content exists: ${tool.id}`);
  assert.match(rows[0], /^ → /, `compact prefix: ${tool.id}`);
  for (const row of rows.slice(1)) assert.match(row, /^ {3}\S/, `continuation aligns at tool-name column: ${tool.id}`);
  assert.match(rows.at(-1), tool.isError ? /✗$/u : /✓$/u, `marker ends final content row: ${tool.id}`);
  return rows;
}
function compact(dump) {
  const reads = byName(dump, 'read');
  assert.equal(reads.length, 3);
  for (const [i, tool] of reads.entries()) {
    const rows = compactContent(tool);
    if (i < 2) assert.equal(rows.length, 1, `short read stays single-row: ${tool.id}`);
    assert.match(rows[0], /\bread\b/);
    assert.match(rows.at(-1), i === 2 ? /✗/ : /✓/);
  }
  assert.match(summaryText(reads[2]), /ENOENT|nosuch|notfound|Error/i);
  const unknown = byName(dump, 'tv_unknown')[0];
  assert.equal(lines(unknown).length, 1);
  assert.match(lines(unknown)[0], /tv_unknown.*✓|✓.*tv_unknown/);
  const a = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(a >= 0, 'first compact read is on the real screen');
  assert.match(dump.screen[a + 1], /\bread\b.*b\.txt/, 'consecutive compact reads have no blank screen row');
  assert.match(dump.screen[a], /✓/);
  assert.ok(!dump.screen.some((line) => /READ_[AB]_CONTENT|UNKNOWN_RESULT/.test(line)), 'collapsed output is hidden on screen');
  // Compact summaries have no card background, including their text cells.
  for (const y of [a, a + 1]) {
    const x = dump.screen[y].indexOf('read');
    assert.equal(dump.cells[y][x].bgMode, 0, 'compact summary has terminal-default background');
  }
  const doc = dump.document.map(plain);
  const first = doc.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(first >= 0);
  assert.match(doc[first + 1], /\bread\b.*b\.txt/);
}

async function semanticColors(dump) {
  const row = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(row >= 0);
  assert.match(dump.screen[row], /read a\.txt \[offset=1, limit=1\]/);
  const samples = [
    ['dim', '→'], ['toolTitle', 'read'], ['muted', 'a.txt'], ['dim', '[offset='],
  ];
  const reference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    for (const [role, text] of samples) {
      reference.reset();
      await new Promise((done) => reference.write(dump.summaryStyles[role], done));
      const expected = reference.buffer.active.getLine(0).getCell(0);
      const actual = dump.cells[row][dump.screen[row].indexOf(text)];
      assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim },
        { fg: expected.getFgColor(), fgMode: expected.getFgColorMode(), dim: expected.isDim() },
        `real screen ${text} uses theme role ${role}`);
    }
  } finally { reference.dispose(); }
  const custom = dump.screen.find((line) => line.includes('→ tv_unknown'));
  assert.match(custom, /tv_unknown \[query="wide/);
}

const stockOnly = process.env.TOOLVIEW_TERMINAL_STOCK_ONLY === '1';
const leadingBlanks = (tool) => tool.lines.findIndex((row) => plain(row).trim());
function nativeAfterMultiline(tool, control) {
  const expected = leadingBlanks(control) === 0 ? ['', ...control.lines] : control.lines;
  assert.deepEqual(tool.lines, expected, `native ${tool.name} unchanged except missing separator`);
  assert.equal(leadingBlanks(tool), 1, `exactly one native separator: ${tool.name}`);
}
function multilineLayout(dump, wide) {
  const reads = byName(dump, 'read');
  const empty = byName(dump, 'tv_noargs');
  const summaries = byName(dump, 'tv_summary');
  assert.equal(reads.length, 4);
  assert.equal(summaries.length, 8);
  assert.equal(empty.length, 3);
  for (const hidden of byName(dump, 'tv_hidden')) assert.deepEqual(hidden.lines, [], 'hidden components have zero rows');
  for (const tool of dump.tools.filter((tool) => ['read', 'tv_noargs', 'tv_summary'].includes(tool.name))) {
    compactContent(tool);
    assert.ok(leadingBlanks(tool) <= 1, `never duplicate separator: ${tool.id}`);
    assert.ok(plain(tool.lines.at(-1)).trim(), `no trailing separator: ${tool.id}`);
    if (wide) assert.equal(summaryText(tool), summaryText(wide.tools.find((item) => item.id === tool.id)), 'every value survives narrow wrapping');
  }
  assert.equal(leadingBlanks(reads[1]), 0, 'single follows single without separator');
  assert.equal(leadingBlanks(reads[2]), 0, 'multiline following single has no separator');
  assert.ok(lines(reads[2]).length > 1, 'real long-path read wraps');
  assert.equal(leadingBlanks(empty[0]), 1, 'hidden between multiline and next is skipped');
  assert.equal(leadingBlanks(empty[1]), 0, 'leading separator does not turn prior single into multiline');
  assert.equal(leadingBlanks(summaries[0]), 0, 'multiline after single has no separator');
  assert.equal(leadingBlanks(summaries[1]), 0, 'pattern call follows single read without separator');
  assert.equal(summaryText(empty[0]), summaryExpected('tv_noargs ✓'), 'no invented no-args placeholder');
  assert.equal(summaryText(reads[2]), summaryExpected('read long-directory/' + 'r'.repeat(180) + '.txt [offset=1, limit=1] ✓'));
  const query = 'quoted "query"\\value 界 é ' + 'UNBREAKABLE'.repeat(30) + ' END_QUERY_VISIBLE';
  const parameters = [
    `query=${JSON.stringify(query)}`, 'queries=["first","second"]', 'op="trace"', 'action="inspect"', 'symbol="symbol"', 'symbols=["one","two"]',
    'command="command"', 'subject="subject"', 'offset=0', 'limit=0', 'startLine=0', 'endLine=0',
    'AFirst="FIRST_ALPHA_VISIBLE"', 'Authorization="<redacted>"', 'Content="CASE_SENSITIVE_PAYLOAD_VISIBLE"', 'Token="CASE_SENSITIVE_TOKEN_VISIBLE"',
    'access_token="<redacted>"', 'apiKey="<redacted>"', 'api_key="<redacted>"', 'authorization="<redacted>"', 'count=0', 'empty=""', 'enabled=false', 'maxTokens=0',
    'nested={"input":"NESTED_PAYLOAD_VISIBLE","token":"NESTED_TOKEN_VISIBLE","values":[false,0,"nested quoted value"],"clean":"clean nestedvalue"}',
    'nothing=null', '"odd key"="QUOTED_KEY"', 'passwd="<redacted>"', 'password="<redacted>"', 'refresh_token="<redacted>"', 'sanitized="white space redend"', 'secret="<redacted>"', 'token="<redacted>"', 'zLast="LAST_FIELD_VISIBLE"',
  ];
  assert.equal(summaryText(summaries[0]), summaryExpected('tv_summary [' + parameters.join(', ') + '] ✓'), 'complete priority/alpha ordering, JSON values, exact payload exclusion and top-level masking');
  assert.doesNotMatch(summaries[0].lines.join(''), /\u202e|\u001b\[31m/u, 'top-level and nested controls cannot affect terminal presentation');
  assert.ok(lines(summaries[0]).length > (dump.width === 24 ? 30 : 4), 'long summary is not bounded by old argument or row caps');
  const expected = [
    'tv_summary "needle \\"quoted\\"" [paths=["ordinary-path"], path=["src dir","tests"], target="ordinary-target", url="https://example.invalid/ordinary", scope="ordinary-scope", query="always named", enabled=true] ✓',
    'tv_summary "chosen target" [paths=["ordinary-path"], path=null, url="ordinary-url", scope="ordinary-scope", query="named", pattern=0] ✓',
    'tv_summary chosen-path [paths=["ordinary-path"], target="ordinary-target", url="ordinary-url", scope="ordinary-scope"] ✓',
    'tv_summary https://example.invalid/chosen [paths=[], scope="ordinary-scope", pattern=false] ✓',
    'tv_summary [paths=["ordinary-path"], scope=[]] ✓',
    'tv_summary [paths=[]] ✓',
    'tv_summary "" [path=[], query=""] ✓',
  ];
  for (const [index, expectedSummary] of expected.entries())
    assert.equal(summaryText(summaries[index + 1]), summaryExpected(expectedSummary), `primary selection case ${index + 1}`);
}


test('real CLI: isolated offline stock control and terminal transport', { timeout: 60000 }, async () => {
  const stock = new PiTerminal('stock-control');
  try {
    await stock.ready(); await stock.run();
    const dump = await stock.capture('collapsed');
    assert.equal(dump.tools.length, 7);
    assert.deepEqual(stock.events().filter((e) => e.type === 'call').map((e) => e.name),
      ['read', 'read', 'bash', 'write', 'edit', 'tv_unknown', 'read']);
    assert.equal(stock.events().filter((e) => e.type === 'result').at(-1).isError, true);
    assert.ok(byName(dump, 'read')[0].lines.length > 2, 'stock read has card padding');
    const stockRow = dump.screen.findIndex((line) => line.includes('read a.txt'));
    assert.ok(stockRow >= 0);
    assert.notEqual(dump.cells[stockRow][dump.screen[stockRow].indexOf('read')].bgMode, 0);
    for (const text of ['BASH_RESULT', 'UNKNOWN_RESULT'])
      assert.ok(dump.screen.some((line) => line.includes(text)), `stock screen shows ${text}`);
    assert.equal(readFileSync(join(stock.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
    stock.send('\x0f'); await stock.settle();
    const expanded = await stock.capture('expanded');
    assert.ok(expanded.tools.every((tool) => tool.expanded), 'real Ctrl+O reaches Pi');
    for (const text of ['READ_A_CONTENT', 'READ_B_CONTENT'])
      assert.ok(expanded.screen.some((line) => line.includes(text)), `expanded stock shows ${text}`);
    stock.send('\x0f'); await stock.settle();
    await stock.resize(24);
    const narrow = await stock.capture('narrow');
    assert.equal(narrow.width, 24);
    await stock.resize(100);
    await stock.command('/tv-theme light');
    assert.equal(stock.events().findLast((e) => e.type === 'theme').result.success, true);
    await stock.capture('light');
    copyFileSync(dump.session, join(stock.output, 'session.jsonl'));
  } finally { await stock.close(); stock.dispose(); }
});

test('real CLI: Toolview policy, input, lifecycle and same-session stock replay',
  { skip: stockOnly, timeout: 180000 }, async () => {
    assert.ok(existsSync(extension), 'Implement src/index.ts first; use TOOLVIEW_TERMINAL_STOCK_ONLY=1 for transport validation');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); return terminal;
    };
    try {
      const stock = await start('comparison-stock', {});
      await stock.run(); const control = await stock.capture('collapsed');
      stock.send('\x0f'); await stock.settle(); const controlExpanded = await stock.capture('expanded');
      const live = await start('toolview-fullscreen', { toolview: true, workspace: stock.work });
      await live.run(); const collapsed = await live.capture('collapsed'); compact(collapsed);
      await semanticColors(collapsed);
      assert.deepEqual(execution(live), execution(stock), 'real calls, results, and provider-visible results stay unchanged');
      assert.deepEqual(persisted(collapsed), persisted(control), 'persisted tool messages stay unchanged');
      assert.equal(readFileSync(join(live.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
      // Only cross-run live bash runtime text is normalized; same-process and replay checks below are exact.
      for (const name of ['bash', 'write', 'edit'])
        assert.deepEqual(toolLines({ tools: byName(collapsed, name) }),
          toolLines({ tools: byName(control, name) }), `native ${name} card`);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(controlExpanded));
      assert.ok(expanded.screen.some((line) => line.includes('READ_A_CONTENT')));
      live.send('\x0f'); await live.settle(); const recollapsed = await live.capture('recollapsed');
      assert.deepEqual(toolLines(recollapsed), toolLines(collapsed)); compact(recollapsed);
      const row = recollapsed.screen.findIndex((line) => /\bread\b.*b\.txt/.test(line));
      const column = recollapsed.screen[row].indexOf('read') + 1;
      live.send(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await live.settle(); const clicked = await live.capture('clicked');
      assert.equal(byName(clicked, 'read')[0].expanded, false);
      assert.equal(byName(clicked, 'read')[1].expanded, true, 'SGR click expands precisely the chosen compact row');
      assert.ok(clicked.screen.some((line) => line.includes('READ_B_CONTENT')));
      // Collapse with stock mouse handling on the expanded title, not direct method invocation.
      const titleRow = clicked.screen.findIndex((line) => line.includes('b.txt'));
      assert.ok(titleRow >= 0);
      live.send(`\x1b[<0;${column};${titleRow + 1}M\x1b[<0;${column};${titleRow + 1}m`);
      await live.settle(); compact(await live.capture('mouse-collapsed'));
      await live.command('/toolview status');
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.ok(off.screen.some((line) => line.includes('read a.txt')));
      const offRow = off.screen.findIndex((line) => line.includes('read a.txt'));
      assert.notEqual(off.cells[offRow][off.screen[offRow].indexOf('read')].bgMode, 0, 'disabled read is a stock card on screen');
      await live.command('/toolview on'); compact(await live.capture('enabled'));
      await live.command('/toolview on'); compact(await live.capture('enabled-twice'));
      const starts = live.events().filter((e) => e.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      compact(await live.capture('reloaded'));
      await live.run('future');
      const future = await live.capture('future-after-reload');
      assert.equal(byName(future, 'tv_unknown').length, 2);
      assert.equal(lines(byName(future, 'tv_unknown')[1]).length, 1, 'future attachment is compact after reload');
      assert.match(lines(byName(future, 'tv_unknown')[1])[0], /tv_unknown.*✓|✓.*tv_unknown/);
      compact(future);
      await live.resize(24); const narrow = await live.capture('narrow');
      assert.equal(narrow.width, 24);
      for (const tool of narrow.tools.filter((t) => ['read', 'tv_unknown'].includes(t.name))) {
        compactContent(tool);
        const wideTool = future.tools.find((candidate) => candidate.id === tool.id);
        assert.equal(summaryText(tool), summaryText(wideTool), 'narrow wrapping retains complete summary');
        await assertFits(tool.lines, 24);
      }
      const narrowReads = narrow.screen.filter((line) => /\bread\b/.test(line));
      assert.equal(narrowReads.length, 3, 'each narrow read has exactly one first row');
      assert.ok(narrow.screen.some((line) => /→ tv_unknown/.test(line)));
      assert.ok(narrow.screen.some((line) => /[✓✗]/.test(line)), 'wrapped markers remain on the actual screen');
      await live.resize(100);
      const dark = await live.capture('dark');
      await live.command('/tv-theme light'); const light = await live.capture('light'); compact(light);
      await semanticColors(light);
      assert.equal(live.events().findLast((e) => e.type === 'theme').result.success, true);
      assert.deepEqual(light.tools.map((t) => t.lines.map(plain)), dark.tools.map((t) => t.lines.map(plain)));
      assert.notDeepEqual(byName(light, 'read')[0].lines, byName(dark, 'read')[0].lines, 'theme colors are refreshed');
      await live.command('/tv-theme dark');
      const beforeReplay = await live.capture('before-replay');
      const session = beforeReplay.session;
      copyFileSync(session, join(live.output, 'session.jsonl'));
      await live.close();
      const replay = await start('toolview-replay', { toolview: true, session, workspace: stock.work });
      const resumed = await replay.capture('collapsed'); compact(resumed);
      const nativeReplay = await start('stock-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('collapsed');
      for (const name of ['bash', 'write', 'edit'])
        assert.deepEqual(byName(resumed, name).map((t) => t.lines), byName(native, name).map((t) => t.lines), `same-session native ${name} replay`);
      assert.deepEqual(resumed.tools.map(({ name, content }) => ({ name, content })), beforeReplay.tools.map(({ name, content }) => ({ name, content })));
      await replay.command('/toolview off'); const disabledReplay = await replay.capture('disabled');
      assert.deepEqual(disabledReplay.tools.map((t) => t.lines), native.tools.map((t) => t.lines), 'disable restores exact same-session stock rendering');
      const regular = await start('toolview-regular', { toolview: true, mode: 'regular' });
      await regular.run(); compact(await regular.capture('collapsed'));
      regular.send('\x0f'); await regular.settle(); const regularExpanded = await regular.capture('expanded');
      assert.ok(regularExpanded.tools.every((t) => t.expanded));
      assert.ok(regularExpanded.screen.some((line) => line.includes('READ_B_CONTENT')));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: complete multiline summaries, adaptive separation, continuation clicks and replay',
  { skip: stockOnly, timeout: 180000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const events = (terminal) => {
      const observed = terminal.events();
      assert.equal(observed.filter((event) => event.type === 'call').length, 19);
      assert.equal(observed.filter((event) => event.type === 'result').length, 19);
      assert.equal(observed.filter((event) => event.type === 'model_context').length, 20);
      return observed.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    const flags = ['--toolview-card', 'tv_card'];
    try {
      const stock = await start('multiline-stock');
      await stock.run('multiline'); const control = await stock.capture('collapsed');
      const live = await start('multiline-toolview', { toolview: true, flags, workspace: stock.work });
      await live.run('multiline'); const wide = await live.capture('wide');
      multilineLayout(wide);
      assert.deepEqual(events(live), events(stock), '19 real calls/results and 20 model contexts remain exact');
      assert.deepEqual(persisted(wide), persisted(control), 'full payloads and synthetic secrets remain native session data');
      assert.ok(persisted(wide).some((entry) => entry.arguments?.token === 'TOP_TOKEN_HIDDEN'));
      assert.ok(byName(wide, 'tv_summary')[0].content[0].text.includes('PAYLOAD_CONTENT_HIDDEN'));
      for (const tool of wide.tools) await assertFits(tool.lines, 100);
      nativeAfterMultiline(byName(wide, 'tv_card')[0], byName(control, 'tv_card')[0]);
      assert.deepEqual(toolLines({ tools: byName(wide, 'bash') }), toolLines({ tools: byName(control, 'bash') }), 'real native bash card retains its own separator');
      const reads = byName(wide, 'read');
      const readRow = wide.screen.findIndex((row) => row === lines(reads[2])[0]);
      assert.ok(readRow >= 0, 'real multiline read is on screen');
      assert.deepEqual(wide.screen.slice(readRow, readRow + lines(reads[2]).length), lines(reads[2]), 'every read continuation is real screen content');
      const afterRead = readRow + lines(reads[2]).length;
      assert.equal(wide.screen[afterRead], '', 'one screen gap before following no-args call');
      assert.match(wide.screen[afterRead + 1], /→ tv_noargs.*✓/u);
      assert.match(wide.screen[afterRead + 2], /→ tv_noargs.*✓/u, 'single with leading gap is not counted as multiline');
      assert.match(wide.screen[afterRead + 3], /→ tv_summary/u, 'multiline after single stays adjacent');
      const summary = byName(wide, 'tv_summary')[0];
      const summaryRow = wide.screen.findIndex((row) => row === lines(summary)[0]);
      assert.ok(summaryRow >= 0);
      assert.deepEqual(wide.screen.slice(summaryRow, summaryRow + lines(summary).length), lines(summary), 'all fields appear on the actual wide screen');
      const styleReference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
      try {
        await new Promise((done) => styleReference.write(wide.summaryStyles.dim, done));
        const expectedStyle = styleReference.buffer.active.getLine(0).getCell(0);
        for (let y = summaryRow; y < summaryRow + lines(summary).length; y++) {
          const x = wide.screen[y].search(/\S/u);
          const cell = wide.cells[y][x];
          assert.equal(cell.bgMode, 0, 'continuations have no native-card background');
          if (y > summaryRow) assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
            { fg: expectedStyle.getFgColor(), fgMode: expectedStyle.getFgColorMode(), dim: expectedStyle.isDim() },
            'wrapped parameter rows retain theme dim foreground');
        }
      } finally { styleReference.dispose(); }
      // Real fullscreen SGR on the extension-added gap must not expand either neighbor.
      live.send(`\x1b[<0;4;${afterRead + 1}M\x1b[<0;4;${afterRead + 1}m`);
      await live.settle(); const gap = await live.capture('gap-click');
      assert.ok(gap.tools.every((tool) => !tool.expanded), 'gap ignores primary clicks');
      // Click the last content row (not just the title) of the long built-in read.
      const continuation = gap.screen.findIndex((row) => row === lines(reads[2]).at(-1));
      assert.ok(continuation >= 0);
      live.send(`\x1b[<0;4;${continuation + 1}M\x1b[<0;4;${continuation + 1}m`);
      await live.settle(); const clicked = await live.capture('continuation-click');
      assert.deepEqual(clicked.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [reads[2].id], 'continuation expands precisely the completed built-in read');
      assert.ok(clicked.screen.some((row) => row.includes('LONG_READ_CONTENT')));
      // Collapse via the native title after the expanded long filename wraps.
      const pathRow = clicked.screen.findIndex((row) => row.includes('long-directory/'));
      assert.ok(pathRow > 0);
      const title = pathRow - 1; // Native read wraps a long filename below its title.
      assert.match(clicked.screen[title], /\bread\b/u);
      const titleColumn = clicked.screen[title].indexOf('read') + 1;
      assert.ok(titleColumn > 0);
      live.send(`\x1b[<0;${titleColumn};${title + 1}M\x1b[<0;${titleColumn};${title + 1}m`);
      await live.settle(); multilineLayout(await live.capture('native-collapsed'));
      // The next no-args call owns a leading separator; expand then native-collapse it.
      const withGap = await live.capture('with-gap');
      const emptyRow = withGap.screen.findIndex((row, index) => index > readRow && row.includes('→ tv_noargs'));
      assert.ok(emptyRow >= 0, 'separator-owner compact call is on screen');
      live.send(`\x1b[<0;4;${emptyRow + 1}M\x1b[<0;4;${emptyRow + 1}m`);
      await live.settle(); const emptyExpanded = await live.capture('separator-owner-expanded');
      assert.equal(byName(emptyExpanded, 'tv_noargs')[0].expanded, true);
      const emptyTitle = emptyExpanded.screen.findIndex((row) => row.includes('tv_noargs'));
      assert.ok(emptyTitle >= 0);
      const emptyColumn = emptyExpanded.screen[emptyTitle].indexOf('tv_noargs') + 1;
      live.send(`\x1b[<0;${emptyColumn};${emptyTitle + 1}M\x1b[<0;${emptyColumn};${emptyTitle + 1}m`);
      await live.settle(); multilineLayout(await live.capture('separator-owner-collapsed'));
      await live.resize(24, 120); const narrow = await live.capture('narrow');
      multilineLayout(narrow, wide);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      const compactTools = narrow.tools.filter((tool) => ['read', 'tv_summary', 'tv_noargs'].includes(tool.name));
      await t.test('live component render at width zero has no rows', () => {
        for (const tool of compactTools) assert.deepEqual(tool.tinyLines['0'], [], `width zero has no rows: ${tool.id}`);
      });
      await t.test('live component render at widths 1–4 has status only', async () => {
        for (const tool of compactTools) {
          for (const width of [1, 2, 3, 4]) {
            assert.deepEqual(tool.tinyLines[width].map(plain).filter((row) => row.trim()), ['✓'], `width ${width} displays only status`);
            await assertFits(tool.tinyLines[width], width);
          }
        }
      });
      await live.resize(100, 120); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'wide→narrow→wide recalculates content and gaps without drift');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.deepEqual(toolLines(expanded), toolLines(nativeExpanded), 'Ctrl+O returns exact native cards/results');
      assert.deepEqual(persisted(expanded), persisted(wide));
      live.send('\x0f'); await live.settle(); multilineLayout(await live.capture('recollapsed'));
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(toolLines(off), toolLines(control));
      assert.deepEqual(persisted(off), persisted(wide));
      await live.command('/toolview on'); multilineLayout(await live.capture('enabled'));
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); multilineLayout(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = events(live);
      assert.deepEqual(activity, events(stock), 'UI transitions do not re-execute or rewrite model context');
      const session = reloaded.session; await live.close();
      const replay = await start('multiline-replay', { toolview: true, flags, session, workspace: stock.work });
      const resumed = await replay.capture('replayed'); multilineLayout(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(wide));
      const nativeReplay = await start('multiline-native-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('replayed');
      await replay.command('/toolview off'); const replayOff = await replay.capture('disabled');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session off restores native rendering exactly');
      const regular = await start('multiline-regular', { toolview: true, flags, mode: 'regular' });
      await regular.run('multiline'); const regularWide = await regular.capture('wide'); multilineLayout(regularWide);
      await regular.resize(24, 120); const regularNarrow = await regular.capture('narrow');
      multilineLayout(regularNarrow, regularWide);
      for (const tool of regularNarrow.tools) await assertFits(tool.lines, 24);
      await regular.resize(100, 120); const regularBack = await regular.capture('wide-again');
      assert.deepEqual(regularBack.tools.map((tool) => tool.lines), regularWide.tools.map((tool) => tool.lines));
      regular.send('\x0f'); await regular.settle(); assert.ok((await regular.capture('expanded')).tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'multiline-coverage.json'), JSON.stringify({
        calls: 19, results: 19, modelContexts: 20, widths: [0, 1, 2, 3, 4, 24, 100],
        executed: [...new Set(activity.filter((event) => event.type === 'call').map((event) => event.name))],
        input: ['fullscreen SGR separator ignored', 'fullscreen SGR last continuation expands exact read', 'native mouse collapse', 'separator-owner native coordinate forwarding', 'Ctrl+O fullscreen/regular'],
        lifecycle: ['wide→narrow→wide fullscreen/regular', 'off/on', 'reload', 'same-session stock replay'],
        installedTools: 'Separate installed-profile smoke only; no installed tool execution added by multiline fixture',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: width-21 colored-segment boundary preserves content and exact indentation',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((event) => event.type === 'call').length, 2);
      assert.equal(events.filter((event) => event.type === 'result').length, 2);
      assert.equal(events.filter((event) => event.type === 'model_context').length, 3);
      assert.ok(events.filter((event) => event.type === 'result').every((event) => !event.isError));
      return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
    };
    try {
      const stock = await start('boundary-stock');
      await stock.run('boundary'); const control = await stock.capture('wide');
      const live = await start('boundary-toolview', { toolview: true, workspace: stock.work });
      await live.run('boundary'); const wide = await live.capture('wide');
      assert.deepEqual(activity(live), activity(stock), 'boundary execution/model context remain exact');
      assert.deepEqual(persisted(wide), persisted(control));
      await stock.resize(21); const native = await stock.capture('boundary');
      await live.resize(21); const narrow = await live.capture('boundary');
      assert.equal(narrow.width, 21, 'real PTY boundary viewport');
      assert.equal(narrow.tools.length, 2);
      const expected = ['read abcdefghijklm [limit=1] ✓', `tv_summary abcdefghijklm [query="${'x'.repeat(40)}"] ✓`];
      for (const [index, tool] of narrow.tools.entries()) {
        const rows = compactContent(tool);
        const allContentRows = tool.lines.map(plain).slice(leadingBlanks(tool));
        assert.ok(allContentRows.every((row) => row.trim()), 'no blank content row from colored inter-segment spaces');
        assert.deepEqual(allContentRows, rows, 'only an optional leading separator may be empty');
        assert.ok(rows.length > 1, 'both boundary calls wrap');
        assert.equal(summaryText(tool), summaryExpected(expected[index]), 'all content, quotes and status survive segment boundary');
        assert.equal(summaryText(tool), summaryText(wide.tools[index]), 'wide and boundary logical content are identical');
        await assertFits(tool.lines, 21);
        const y = narrow.screen.findIndex((row) => row === rows[0]);
        assert.ok(y >= 0, 'boundary compact call appears on actual ANSI-parsed screen');
        assert.deepEqual(narrow.screen.slice(y, y + rows.length), rows, 'every boundary content row appears on actual screen without extra blank rows');
        for (const row of narrow.screen.slice(y + 1, y + rows.length)) assert.match(row, /^ {3}\S/u, 'parsed continuation has exactly three spaces, never four');
        for (let offset = 0; offset < rows.length; offset++) {
          const x = rows[offset].search(/\S/u);
          assert.equal(narrow.cells[y + offset][x].bgMode, 0, 'boundary summary retains default background');
        }
      }
      assert.deepEqual(lines(narrow.tools[0]), [' → read abcdefghijklm', '   [limit=1] ✓'], 'primary fills width-3 exactly; parameter block starts at column three');
      assert.equal(leadingBlanks(narrow.tools[1]), 1, 'following multiline call receives exactly one separator');
      assert.deepEqual(persisted(narrow), persisted(wide));
      await live.command('/toolview off'); const off = await live.capture('disabled');
      assert.deepEqual(off.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'boundary disable restores exact stock native renderer');
      await live.command('/toolview on'); const enabled = await live.capture('enabled');
      assert.deepEqual(enabled.tools.map((tool) => tool.lines), narrow.tools.map((tool) => tool.lines));
      await live.resize(100); const resizedBack = await live.capture('wide-again');
      assert.deepEqual(resizedBack.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'boundary resize restores exact wide rendering');
      assert.deepEqual(activity(live), activity(stock), 'boundary UI changes do not execute tools again');
      writeFileSync(join(artifacts, 'boundary-coverage.json'), JSON.stringify({
        calls: 2, results: 2, modelContexts: 3, widths: [100, 21, 100],
        arguments: [{ name: 'read', path: 'abcdefghijklm', limit: 1 }, { name: 'tv_summary', path: 'abcdefghijklm', query: 'x'.repeat(40) }],
        checked: ['actual ANSI-parsed content rows', 'exactly three-space continuation', 'no blank content rows', 'complete argument text', 'row widths', 'native off control', 'resize back'],
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });

test('real CLI: gated pending/streaming, image/hidden fallback and exact-name flags',
  { skip: stockOnly, timeout: 120000 }, async (t) => {
    assert.ok(existsSync(extension), 'src/index.ts is required for the implementation gate');
    const terminals = [];
    const start = async (name, options) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal); await terminal.ready(); return terminal;
    };
    try {
      const live = await start('pending', { toolview: true });
      live.send('run pending\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending', { animated: true });
      assert.equal(lines(byName(pending, 'read')[0]).length, 1);
      assert.match(lines(byName(pending, 'read')[0])[0], /…/);
      assert.ok(pending.screen.some((line) => /\bread\b.*…|….*\bread\b/.test(line)));
      writeFileSync(join(live.output, 'provider-go'), 'go'); await live.event('tool_gate');
      const streaming = await live.capture('tool-pending', { animated: true });
      assert.equal(lines(byName(streaming, 'tv_stream')[0]).length, 1);
      assert.match(lines(byName(streaming, 'tv_stream')[0])[0], /…/);
      assert.ok(streaming.screen.some((line) => /tv_stream.*…|….*tv_stream/.test(line)));
      assert.ok(!streaming.screen.some((line) => line.includes('STREAM_PARTIAL')));
      writeFileSync(join(live.output, 'tool-go'), 'go'); await live.event('agent_end');
      const complete = await live.capture('complete');
      assert.match(lines(byName(complete, 'tv_stream')[0])[0], /✓/);
      await live.run('future');
      await live.run('fallback'); const fallback = await live.capture('fallback');
      assert.ok(byName(fallback, 'read').at(-1).content.some((c) => c.type === 'image'), 'real image read produced an image result');
      const native = await start('fallback-stock-replay', { session: fallback.session });
      const stock = await native.capture('fallback');
      await t.test('image fallback matches same-session stock replay', () => {
        assert.deepEqual(byName(fallback, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image rendering stays native');
        assert.ok(fallback.screen.some((line) => line.includes('pixel.png')));
      });
      await t.test('intentionally hidden renderer remains hidden live', () => {
        assert.deepEqual(byName(fallback, 'tv_hidden').map((tool) => tool.lines), byName(stock, 'tv_hidden').map((tool) => tool.lines));
        assert.equal(lines(byName(fallback, 'tv_hidden')[0]).length, 0);
        assert.ok(!fallback.screen.some((line) => line.includes('tv_hidden')));
      });
      const card = await start('flag-card', { toolview: true,
        flags: ['--toolview-card', 'tv_unknown,tv_stream'], session: fallback.session });
      const cards = await card.capture('cards');
      for (const name of ['tv_unknown', 'tv_stream'])
        assert.deepEqual(byName(cards, name)[0].lines, byName(stock, name)[0].lines, `comma-separated card flag: ${name}`);
      const override = await start('flag-override', { toolview: true,
        flags: ['--toolview-card', 'tv_stream,tv_hidden,read', '--toolview-compact', 'tv_stream,tv_hidden,read'], session: fallback.session });
      const overrides = await override.capture('override');
      assert.equal(lines(byName(overrides, 'tv_stream')[0]).length, 1, 'compact override wins');
      await t.test('hidden safeguard wins over flags on replay', () => {
        assert.equal(lines(byName(overrides, 'tv_hidden')[0]).length, 0, 'hidden safeguard wins over flags');
      });
      assert.deepEqual(byName(overrides, 'read').at(-1).lines, byName(stock, 'read').at(-1).lines, 'image safeguard wins over flags');
      const exact = await start('flag-exact', { toolview: true,
        flags: ['--toolview-card', 'tv_strea,READ'], session: fallback.session });
      const exactDump = await exact.capture('exact');
      assert.equal(lines(byName(exactDump, 'tv_stream')[0]).length, 1, 'names are not prefixes');
      assert.equal(lines(byName(exactDump, 'read')[0]).length, 1, 'names are case-sensitive');
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });


test('real CLI: installed-profile registrations and real local task renderers',
  { skip: stockOnly, timeout: 120000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { profileFactory: getInstalledIntegrationProfile, ...options });
      terminals.push(terminal); await terminal.ready(); return terminal;
    };
    // Probe the audited installed sources without importing them or creating host configuration.
    let profile;
    try {
      profile = getInstalledIntegrationProfile({ homeDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`),
        agentDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`, 'agent'),
        workDir: join(tmpdir(), `toolview-profile-probe-${process.pid}`, 'work') });
    } catch (error) {
      if (error.code === 'ENOENT') { t.skip(`Installed-profile source is absent: ${error.path}`); return; }
      throw error;
    }
    writeFileSync(join(artifacts, 'integration-profile-probe.json'), JSON.stringify(profile, null, 2));
    const includedNames = new Set(profile.inventory.filter((entry) => profile.packages.some((pkg) => pkg.source === entry.source))
      .map((entry) => entry.name));
    if (!includedNames.has('@tintinweb/pi-tasks')) {
      t.skip(`Audited configured pi-tasks is required for safe local execution. Exclusions: ${profile.exclusions.map((e) => `${e.name || e.source}: ${e.reason}`).join('; ')}`);
      return;
    }
    const registrationGroups = {
      '@tintinweb/pi-subagents': ['Agent'],
      '@tintinweb/pi-tasks': ['TaskCreate', 'TaskList', 'TaskExecute'],
      '@juicesharp/rpiv-ask-user-question': ['ask_user_question'],
      'pi-web-access': ['web_search', 'fetch_content'],
      '@cortexkit/pi-magic-context': ['ctx_memory', 'ctx_search', 'ctx_note', 'ctx_expand'],
    };
    const assertHealthy = (terminal, dump) => {
      for (const [pkg, names] of Object.entries(registrationGroups)) {
        if (!includedNames.has(pkg)) continue;
        for (const name of names) assert.ok(dump.registrations.includes(name), `installed registration: ${name}`);
      }
      assert.deepEqual(terminal.profile.packages, profile.packages, 'load exactly the current eligible audited configured packages');
      assert.deepEqual(terminal.profile.exclusions, profile.exclusions, 'retain the actual preflight exclusions');
      for (const name of ['@cortexkit/aft-pi', '@pedro_klein/pi-caffeinate'])
        assert.ok(!includedNames.has(name), `unsafe audited package remains excluded: ${name}`);
      const output = plain(Buffer.concat(terminal.raw).toString('utf8'));
      assert.doesNotMatch(output, /Extension "[^"\n]+" error:|Failed to load extension|Error loading extension/i,
        'no extension lifecycle errors (inspect stock-profile evidence separately on failure)');
      // Pi's resource diagnostic component colors load errors with the current error role.
      // [Extension issues] also contains harmless manifest warnings, so the heading alone is not a failure.
      const errorColor = dump.errorStyle.split('TERMINAL_ERROR')[0];
      assert.ok(errorColor, 'theme supplies an error style for native diagnostic inspection');
      assert.ok(dump.extensionIssues.flat().every((line) => !line.includes(errorColor)), 'native extension diagnostics contain no load errors');
      assert.equal(terminal.events().filter((e) => ['provider_error', 'unsafe_call_blocked'].includes(e.type)).length, 0);
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((e) => e.type === 'call').length, 2);
      assert.equal(events.filter((e) => e.type === 'result').length, 2);
      assert.equal(events.filter((e) => e.type === 'model_context').length, 3);
      assert.deepEqual(events.filter((e) => e.type === 'call').map((e) => e.name), ['TaskCreate', 'TaskList']);
      assert.ok(events.filter((e) => e.type === 'result').every((e) => !e.isError));
      return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
    };
    try {
      // Stock goes first so pre-existing package incompatibility cannot be blamed on Toolview.
      const stock = await start('installed-stock');
      const stockStartup = await stock.capture('startup'); assertHealthy(stock, stockStartup);
      await stock.run('integration'); const control = await stock.capture('collapsed'); assertHealthy(stock, control);
      assert.equal(control.tools.length, 2);
      assert.ok(control.screen.some((line) => line.includes('created successfully')));
      assert.match(byName(control, 'TaskList')[0].content[0].text, /#1 \[pending\] TERMINAL_LOCAL_TASK/);
      const live = await start('installed-toolview', { toolview: true, workspace: stock.work });
      await live.run('integration'); const compacted = await live.capture('collapsed'); assertHealthy(live, compacted);
      assert.deepEqual(compacted.extensionIssues, control.extensionIssues, 'existing package warnings are identical with and without Toolview');
      assert.deepEqual(activity(live), activity(stock), 'same installed-profile calls/results and model-facing contents are unchanged');
      assert.deepEqual(persisted(compacted), persisted(control));
      assert.equal(compacted.tools.length, 2);
      for (const name of ['TaskCreate', 'TaskList']) {
        const tool = byName(compacted, name)[0];
        const rows = compactContent(tool);
        assert.match(rows[0], new RegExp(name));
        assert.match(rows.at(-1), /✓$/u);
        if (name === 'TaskList') assert.equal(rows.length, 1, 'no-args real task stays single-row');
        const row = compacted.screen.findIndex((line) => line.includes(`→ ${name}`));
        assert.ok(row >= 0, `real installed ${name} summary is on screen`);
        assert.equal(compacted.cells[row][compacted.screen[row].indexOf(name)].bgMode, 0);
      }
      assert.ok(!compacted.screen.some((line) => line.includes('created successfully')), 'native task result is hidden while collapsed');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.screen.some((line) => line.includes('created successfully')));
      assert.deepEqual(expanded.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content));
      live.send('\x0f'); await live.settle();
      await live.command('/toolview off'); const disabled = await live.capture('disabled'); assertHealthy(live, disabled);
      assert.deepEqual(disabled.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content), 'within-profile off preserves actual results');
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines));
      assert.ok(disabled.screen.some((line) => line.includes('created successfully')));
      const replay = await start('installed-stock-replay', { session: compacted.session, workspace: stock.work });
      const nativeReplay = await replay.capture('replay'); assertHealthy(replay, nativeReplay);
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), nativeReplay.tools.map((tool) => tool.lines), 'same-session installed stock renderer is restored exactly');
      writeFileSync(join(artifacts, 'integration-coverage.json'), JSON.stringify({
        executed: ['TaskCreate', 'TaskList'], registrations: compacted.registrations,
        stockExtensionDiagnostics: control.extensionIssues, patchedExtensionDiagnostics: compacted.extensionIssues,
        packages: live.profile.inventory.filter((entry) => live.profile.packages.some((p) => p.source === entry.source)),
        exclusions: live.profile.exclusions, limitations: live.profile.limitations,
        rendererCoverage: '@tintinweb/pi-tasks real tools through their registered native/default renderer; other installed tools registration only',
      }, null, 2));
    } finally {
      for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); }
    }
  });
