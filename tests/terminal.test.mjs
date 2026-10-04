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
    this.pointerInputs = [];
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
      if (/\x1b\[<|\x1b\[[IO]/u.test(data)) this.pointerInputs.push(data);
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
  async resize(cols, rows = 80, animated = false) {
    this.term.resize(cols, rows);
    this.child.stdin.write(JSON.stringify({ resize: [cols, rows] }) + '\n');
    await sleep(80);
    await this.settle(animated);
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    writeFileSync(join(this.output, 'terminal.ansi'), Buffer.concat(this.raw));
    writeFileSync(join(this.output, 'bridge.stderr'), this.stderr);
    writeFileSync(join(this.output, 'pointer-inputs.json'), JSON.stringify(this.pointerInputs, null, 2));
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
      simpleBashCards(collapsed);
      assert.deepEqual(execution(live), execution(stock), 'real calls, results, and provider-visible results stay unchanged');
      assert.deepEqual(persisted(collapsed), persisted(control), 'persisted tool messages stay unchanged');
      assert.equal(readFileSync(join(live.work, 'written.txt'), 'utf8'), 'WRITE_AFTER\n');
      // Only cross-run live bash runtime text is normalized; same-process and replay checks below are exact.
      for (const name of ['write', 'edit'])
        assert.deepEqual(toolLines({ tools: byName(collapsed, name) }),
          toolLines({ tools: byName(control, name) }), `native ${name} card`);
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      simpleBashCards(expanded);
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: controlExpanded.tools.filter((tool) => tool.name !== 'bash') }));
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
      const resumed = await replay.capture('collapsed'); compact(resumed); simpleBashCards(resumed);
      const nativeReplay = await start('stock-replay', { session, workspace: stock.work });
      const native = await nativeReplay.capture('collapsed');
      for (const name of ['write', 'edit'])
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
      simpleBashCards(wide, 'MULTILINE_NATIVE_BASH');
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
      simpleBashCards(expanded, 'MULTILINE_NATIVE_BASH');
      assert.deepEqual(toolLines({ tools: expanded.tools.filter((tool) => tool.name !== 'bash') }),
        toolLines({ tools: nativeExpanded.tools.filter((tool) => tool.name !== 'bash') }), 'Ctrl+O returns exact native cards/results except custom bash');
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

// Bash-card oracle uses plain ASCII hard-cell wrapping, independent of production layout.
function bashArguments(dump) {
  return persisted(dump).filter((entry) => entry.name === 'bash').map((entry) => entry.arguments);
}
function hardRows(text, width) {
  return text.split('\n').flatMap((row) => {
    let expanded = '';
    for (const char of row) expanded += char === '\t' ? ' '.repeat(8 - expanded.length % 8) : char;
    return expanded.length ? Array.from({ length: Math.ceil(expanded.length / width) }, (_, i) => expanded.slice(i * width, (i + 1) * width)) : [''];
  });
}
// Contract arithmetic only: never import the production frame/layout/paint helpers.
function bashGeometry(width) {
  if (width >= 6) return { left: 1, border: 1, inside: 1, insideRight: 1, right: 1, origin: 3, content: width - 5 };
  let spare = Math.max(0, width - 1);
  const border = Math.min(1, spare); spare -= border;
  const padding = Math.min(2, spare); spare -= padding;
  const inside = Math.ceil(padding / 2), insideRight = Math.floor(padding / 2);
  const left = Math.floor(spare / 2), right = spare - left;
  return { left, border, inside, insideRight, right, origin: left + border + inside, content: width ? 1 : 0 };
}
function bashExpected(tool, args, dump, { partial = false } = {}) {
  const width = bashGeometry(dump.width).content;
  const comments = [];
  if (args.description?.trim()) comments.push('# ' + args.description.trim());
  if (args.workdir && resolve(dump.cwd, args.workdir) !== resolve(dump.cwd)) comments.push('# Running in ' + resolve(dump.cwd, args.workdir));
  const rows = comments.flatMap((row) => hardRows(row, width));
  if (comments.length) rows.push('');
  rows.push(...hardRows('$ ' + args.command, width));
  const output = (tool.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').replace(/\r\n?/g, '\n');
  const code = tool.details?.exit_code;
  const nonzero = Number.isFinite(code) && Number.isInteger(code) && code !== 0;
  const footer = nonzero ? `[exit code: ${code}${tool.isError ? '; error: execution failed' : ''}]` : tool.isError ? '[error: execution failed]' : '';
  const logical = output.split('\n');
   while (logical.length && !logical.at(-1).trim()) logical.pop();
  // One final, exact logical suffix only: never parse status from output or compare wrapped rows.
  if (!partial && nonzero && logical.at(-1) === footer && logical.length > 1 && !logical.at(-2).trim()) {
    logical.pop();
    while (logical.length && !logical.at(-1).trim()) logical.pop();
  }
   // Keep the leading separator available for a suffix-only duplicate before edge trimming.
   while (logical.length && !logical[0].trim()) logical.shift();
   // Deliberately wrap all ASCII output; production's bounded 11-row iterator is not this oracle.
  const visual = logical.length ? hardRows(logical.join('\n'), width) : [];
  if (visual.length) {
    const preview = tool.expanded ? visual : visual.slice(0, 10);
    if (!tool.expanded && visual.length > 10) while (preview.length && !preview.at(-1).trim()) preview.pop();
    rows.push('', ...preview);
    if (!tool.expanded && visual.length > 10) {
      const hint = '… (Click to expand)';
      rows.push(hint.length <= width ? hint : width <= 3 ? '.'.repeat(width) : hint.slice(0, width - 3) + '...');
    }
  }
  if (!partial && footer) rows.push('', ...hardRows(footer, width));
  return rows;
}
function bashCard(tool, args, dump, options) {
  assert.equal(typeof args.command, 'string');
  const actual = tool.lines.map((row) => stripVTControlCharacters(row));
  if (dump.width === 0) { assert.deepEqual(actual, []); return; }
  const geometry = bashGeometry(dump.width);
  const top = geometry.border ? actual.findIndex((row) => row.includes('┃')) : actual[0] === '' ? 1 : 0;
  assert.ok(top === 0 || top === 1, 'at most one unpainted transcript separator before panel');
  if (top) assert.equal(actual[0], '', 'outside separator is genuinely empty, not a painted panel row');
  const frame = (body = '') => ' '.repeat(geometry.left) + (geometry.border ? '┃' : '') +
    ' '.repeat(geometry.inside) + body.padEnd(geometry.content) + ' '.repeat(geometry.insideRight + geometry.right);
  assert.equal(actual[top], frame(), 'exact full-panel top padding row, including left marker and exterior margins');
  assert.equal(actual.at(-1), frame(), 'exact full-panel bottom padding row');
  const expected = bashExpected(tool, args, dump, options);
  assert.deepEqual(actual.slice(top + 1, -1), expected.map(frame), 'independent W-5 oracle: complete body, left marker, one inside cell per side, exact exterior margins');
  assert.doesNotMatch(actual.join('\n'), /Took \d|✓| → bash/, 'custom bash card has no native title/runtime/success marker');
}
function allBashCards(dump, options) {
  const args = bashArguments(dump);
  assert.equal(args.length, byName(dump, 'bash').length);
  byName(dump, 'bash').forEach((tool, i) => bashCard(tool, args[i], dump, options));
}
function simpleBashCards(dump, result = 'BASH_RESULT') {
  allBashCards(dump);
  assert.ok(byName(dump, 'bash')[0].lines.some((row) => plain(row).includes(result)));
}
function traffic(terminal, count) {
  const events = terminal.events();
  assert.equal(events.filter((event) => event.type === 'call').length, count);
  assert.equal(events.filter((event) => event.type === 'result').length, count);
  assert.equal(events.filter((event) => event.type === 'model_context').length, count + 1);
  assert.equal(events.filter((event) => event.type === 'provider_error').length, 0);
  return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
}
async function mouseAt(terminal, dump, needle, { offset = 0, button = 0, animated = false } = {}) {
  const y = dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `mouse target is on real screen: ${needle}`);
  const x = Math.max(1, dump.screen[y].indexOf(needle) + 1);
  terminal.send(`\x1b[<${button};${x};${y + 1 + offset}M\x1b[<${button};${x};${y + 1 + offset}m`);
  await terminal.settle(animated);
}
async function bashScreenStyle(dump, needle, role, background) {
  // Heredoc data is present in both supplied command and returned output; sample the output occurrence.
  const y = role === 'toolOutput' ? dump.screen.findLastIndex((row) => row.includes(needle)) : dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `styled content appears on screen: ${needle}`);
  const actual = dump.cells[y][dump.screen[y].indexOf(needle)];
  const ref = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => ref.write(dump.summaryStyles[role], done));
    let cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ fg: actual.fg, mode: actual.fgMode, dim: actual.dim },
      { fg: cell.getFgColor(), mode: cell.getFgColorMode(), dim: cell.isDim() }, `screen foreground: ${role}`);
    ref.reset();
    await new Promise((done) => ref.write(dump.backgroundStyles[background], done));
    cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ bg: actual.bg, mode: actual.bgMode }, { bg: cell.getBgColor(), mode: cell.getBgColorMode() }, `screen background: ${background}`);
  } finally { ref.dispose(); }
}

function panelAt(dump, index, needle) {
  const tool = byName(dump, 'bash')[index];
  const component = tool.lines.map((row) => stripVTControlCharacters(row));
  const top = component.findIndex((row) => row.includes('┃'));
  const row = component.findIndex((line) => line.includes(needle));
  const screen = dump.screen.findIndex((line) => line.includes(needle));
  assert.ok(top >= 0 && row > top && screen >= 0, `panel ${index} anchor on actual screen: ${needle}`);
  const y = screen - row + top;
  const bottom = y + component.length - top - 1;
  assert.ok(y > 0 && bottom < dump.screen.length, 'complete panel and preceding separator visible');
  return { y, bottom, command: screen, left: 1, right: dump.width - 2 };
}
async function sgrAt(terminal, x, y, button = 0, release = true) {
  if (button === 0 && release && terminal.lastSingleClick) {
    // Distinct single clicks must not become Pi's native <=500ms word/line selection.
    await sleep(Math.max(0, 520 - (Date.now() - terminal.lastSingleClick)));
  }
  terminal.send(`\x1b[<${button};${x + 1};${y + 1}M` + (release ? `\x1b[<${button};${x + 1};${y + 1}m` : ''));
  if (button === 0 && release) terminal.lastSingleClick = Date.now();
  await terminal.settle();
}
async function moveAt(terminal, x, y) { await sgrAt(terminal, x, y, 35, false); }
async function referenceCell(style) {
  const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => term.write(style, done));
    const cell = term.buffer.active.getLine(0).getCell(0);
    return { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() };
  } finally { term.dispose(); }
}
async function panelCells(dump, index, needle, { error = false } = {}) {
  const panel = panelAt(dump, index, needle);
  const bg = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const border = await referenceCell(error ? dump.frameStyles.errorBorder : dump.frameStyles.border);
  assert.notEqual(border.fgMode, 0, 'semantic border reference is nondefault');
  if (error) {
    const footerY = dump.screen.findIndex((row, y) => y >= panel.y && y <= panel.bottom && /\[(?:exit code:|error:)/u.test(row));
    assert.ok(footerY >= 0, 'error footer is physically displayed inside the failed panel');
    const footerX = dump.screen[footerY].indexOf('['), footer = dump.cells[footerY][footerX];
    const stripe = dump.cells[footerY][1];
    assert.deepEqual({ fg: stripe.fg, mode: stripe.fgMode, dim: stripe.dim },
      { fg: footer.fg, mode: footer.fgMode, dim: footer.dim }, 'failed stripe matches actual footer foreground');
  }
  for (let y = panel.y; y <= panel.bottom; y++) {
    for (let x = 0; x < dump.width; x++) {
      const cell = dump.cells[y][x];
      if (x < 1 || x >= dump.width - 1) {
        assert.ok(cell.text === '' || cell.text === ' ', `exterior cell is blank at (${x},${y})`);
        assert.equal(cell.bgMode, 0, `exterior background remains terminal default at (${x},${y})`);
      } else if (x === 1) {
        assert.equal(cell.bgMode, 0, `ordinary/error stripe background is terminal default at (${x},${y})`);
      } else {
        assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: bg.bg, bgMode: bg.bgMode }, `whole panel background stays strictly neutral at (${x},${y})`);
      }
    }
    const cell = dump.cells[y][1];
    assert.equal(cell.text, '┃', 'left border on every panel row including padding');
    assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
      { fg: border.fg, fgMode: border.fgMode, dim: border.dim }, 'border foreground matches public active-theme reference');
    for (const x of [2, dump.width - 2]) assert.equal(dump.cells[y][x].text, ' ', 'one inside cell per side');
  }
  assert.equal(dump.screen[panel.y - 1], '', 'exactly one blank transcript separator precedes panel top');
  for (const cell of dump.cells[panel.y - 1]) assert.equal(cell.bgMode, 0, 'preceding transcript separator is outside panel painting');
  for (const y of [panel.y, panel.bottom]) for (let x = 2; x < dump.width - 1; x++)
    assert.equal(dump.cells[y][x].text, ' ', 'full top/bottom panel padding');
  return panel;
}
// Real mouse transport and public selection observation; no component mutation or handler calls.
async function bashPointerChecks(live, initial) {
  let current = initial;
  const anchor = 'for i in $(seq 1 11)';
  const panel = () => panelAt(current, 2, anchor);
  const snapshot = async (name) => { current = await live.capture(`pointer-${name}`); return current; };
  const states = () => current.tools.map((tool) => tool.expanded);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  const noninteractive = panelAt(current, 0, "cat <<'TV_EOF'");
  await moveAt(live, 5, noninteractive.command); await snapshot('nonexpandable-move');
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await sgrAt(live, 2, noninteractive.y); await snapshot('nonexpandable-click');
  assert.ok(current.tools.every((tool) => !tool.expanded), 'nonexpandable panel does not toggle');
  // Native no-button motion must leave every panel cell strictly neutral.
  await moveAt(live, 5, panel().command); await snapshot('enter');
  await panelCells(current, 2, anchor);
  for (const x of [0, current.width - 1]) {
    await moveAt(live, 5, panel().command); await snapshot(`margin-${x}-enter`);
    await panelCells(current, 2, anchor);
    await moveAt(live, x, panel().command); await snapshot(`margin-${x}`);
    await panelCells(current, 2, anchor);
  }
  await moveAt(live, 5, panel().command); await snapshot('before-editor'); await panelCells(current, 2, anchor);
  const editor = current.screen.findLastIndex((line) => /^─/u.test(line));
  assert.ok(editor >= 0, 'native editor boundary visible');
  await moveAt(live, 5, editor + 1); await snapshot('editor-leave'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-focus'); await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('focus-out'); await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('focus-in'); await panelCells(current, 2, anchor);
  // Primary clicks on both exterior cells and the separator are ignored.
  for (const [x, y, label] of [[0, panel().command, 'left'],
    [current.width - 1, panel().command, 'right'], [3, panel().y - 1, 'separator']]) {
    const before = states(); await sgrAt(live, x, y); await snapshot(`outside-click-${label}`); assert.deepEqual(states(), before);
  }
  // A press and drag must remain a host selection, not a captured expansion gesture.
  let p = panel(); const beforeDrag = states();
  await sgrAt(live, 5, p.command, 0, false); await snapshot('press'); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 15, p.command, 32, false);
  live.send(`\x1b[<0;16;${p.command + 1}m`); await live.settle();
  await snapshot('selection-drag');
  assert.equal(current.selectionActive, true, 'public root confirms an actual text selection after SGR drag/release');
  assert.deepEqual(states(), beforeDrag);
  await moveAt(live, 5, p.command); await snapshot('selection-move'); assert.deepEqual(states(), beforeDrag);
  // An actual single click in the exterior resets native selection without toggling the card.
  await sgrAt(live, 0, p.command); await snapshot('selection-cleared'); assert.equal(current.selectionActive, false); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 5, panel().command, 2); await snapshot('secondary'); assert.deepEqual(states(), beforeDrag);
  // Native word selection on a deliberate double-click suppresses the second normalized click.
  await sleep(520); p = panel();
  const click = `\x1b[<0;8;${p.command + 1}M\x1b[<0;8;${p.command + 1}m`;
  live.send(click + click); await live.settle(); await snapshot('active-selection-click');
  assert.equal(current.selectionActive, true, 'actual native double-click selected the command word');
  assert.equal(current.tools[2].expanded, true, 'first click expands; active-selection second click does not collapse');
  assert.ok(current.tools.filter((_, i) => i !== 2).every((tool) => !tool.expanded));
  await sgrAt(live, 0, panel().command); await snapshot('double-selection-cleared'); assert.equal(current.selectionActive, false);
  await sgrAt(live, 2, panel().command); await snapshot('double-selection-restored'); assert.equal(current.tools[2].expanded, false);
  // These coordinates include exact left/right panel bounds, both padding rows and all content roles.
  for (const region of ['border', 'inside', 'inside-right', 'command', 'gap', 'right-edge', 'top', 'bottom']) {
    p = panel();
    const [x, y] = region === 'border' ? [1, p.command] : region === 'inside' ? [2, p.command] :
      region === 'inside-right' ? [current.width - 2, p.command] :
      region === 'command' ? [3, p.command] : region === 'gap' ? [3, p.command + 1] :
      region === 'right-edge' ? [current.width - 2, p.command] : region === 'top' ? [3, p.y] : [3, p.bottom];
    const before = states(); await sgrAt(live, x, y); await snapshot(`panel-${region}`);
    assert.equal(current.tools[2].expanded, !before[2], `whole-panel primary click toggles ${region}`);
    assert.deepEqual(states().filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), 'only receiving card toggles');
    // Restore collapsed through its border for the next region; no direct mutation.
    if (current.tools[2].expanded) { await sgrAt(live, 1, panel().command); await snapshot(`restore-${region}`); }
  }
  // Wheel remains native; no card toggles.
  const beforeWheel = states(); p = panel();
  await sgrAt(live, 5, p.command, 64, false); await snapshot('wheel'); assert.deepEqual(states(), beforeWheel);
  await sgrAt(live, 5, panel().command, 65, false); await snapshot('wheel-back'); assert.deepEqual(states(), beforeWheel);
  live.send('\x0f'); await live.settle(); await snapshot('expanded-transfer-base');
  assert.ok(current.tools.every((tool) => tool.expanded));
  await moveAt(live, 5, panel().command); await snapshot('transfer-from'); await panelCells(current, 2, anchor);
  const first = panelAt(current, 0, "cat <<'TV_EOF'");
  await moveAt(live, 5, first.command); await snapshot('transfer-to');
  await panelCells(current, 0, "cat <<'TV_EOF'"); await panelCells(current, 2, anchor);
  // Expanded error footer remains clickable; motion changes neither neutral paint nor error border.
  await moveAt(live, 5, panelAt(current, 3, "printf 'REAL_ERROR").command); await snapshot('error-move');
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await mouseAt(live, current, '[error: execution failed]'); await snapshot('footer-collapse'); assert.equal(current.tools[3].expanded, false);
  live.send('\x0f'); await live.settle(); await snapshot('collapsed-transfer-end');
  assert.ok(current.tools.every((tool) => !tool.expanded));
  await live.resize(100, 35); await snapshot('wheel-small-viewport');
  const wheelY = current.screen.findIndex((line) => line.includes('REAL_ROW_08'));
  assert.ok(wheelY >= 0, 'interactive output is visible in a genuinely scrollable viewport');
  const wheelScreen = [...current.screen], wheelStates = states();
  await sgrAt(live, 5, wheelY, 64, false); await snapshot('wheel-scroll');
  assert.notDeepEqual(current.screen, wheelScreen, 'uncaptured wheel reaches native transcript scrolling');
  assert.deepEqual(states(), wheelStates, 'native scrolling does not toggle any card');
  await live.resize(100, 150); await snapshot('wheel-restored');
  await moveAt(live, 5, panel().command); await snapshot('before-resize'); await panelCells(current, 2, anchor);
  await live.resize(24, 150); await snapshot('resized');
  await panelCells(current, 2, 'for i in $(seq');
  // Neutral paint must survive resize, re-entry and widening.
  await moveAt(live, 5, panelAt(current, 2, 'for i in $(seq').command); await snapshot('narrow-enter');
  await panelCells(current, 2, 'for i in $(seq');
  await live.resize(100, 150); await snapshot('resize-back'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-off'); await panelCells(current, 2, anchor);
  await live.command('/toolview off'); await snapshot('off');
  await live.command('/toolview on'); await snapshot('on'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-reload'); await panelCells(current, 2, anchor);
  const starts = live.events().filter((event) => event.type === 'start').length;
  await live.command('/reload'); await live.event('start', starts + 1); await snapshot('reload'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('post-reload-enter'); await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('post-reload-leave'); await panelCells(current, 2, anchor);
  // Native /settings replaces the renderer without reloading extensions or transcript components.
  const modeEvents = live.events();
  const modeTraffic = traffic(live, 4);
  const nativeMode = async (from, to) => {
    await live.command('/settings');
    live.send('TUI mode'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${from}\\s*$`, 'u').test(row)),
      `native settings search selects TUI mode: ${from}`);
    // SettingsList cycles values immediately on Enter; Esc only closes the selector.
    live.send('\r'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${to}\\s*$`, 'u').test(row)),
      `native settings Enter switches TUI mode: ${to}`);
    assert.equal(live.term.buffer.active.type, to === 'fullscreen' ? 'alternate' : 'normal',
      'actual terminal buffer reflects the native renderer replacement');
    live.send('\x1b'); await live.settle();
    assert.ok(!live.screen().some((row) => /→ TUI mode\s+/u.test(row)), 'Esc closes native settings');
  };
  await moveAt(live, 5, panel().command); await snapshot('mode-before-regular');
  await panelCells(current, 2, anchor);
  await nativeMode('fullscreen', 'regular'); await snapshot('mode-regular'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => !tool.expanded), 'regular replacement retains collapsed state');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-expanded'); allBashCards(current);
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => tool.expanded), 'real Ctrl+O expands retained tools in regular mode');
  assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')), 'regular expanded output appears on actual screen');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-collapsed'); allBashCards(current);
  await panelCells(current, 2, anchor);
  assert.ok(current.tools.every((tool) => !tool.expanded), 'real Ctrl+O collapses retained tools in regular mode');
  await nativeMode('regular', 'fullscreen'); await snapshot('mode-fullscreen'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TV_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-enter');
  await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('mode-fullscreen-margin-leave');
  await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-focus-enter');
  await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('mode-fullscreen-focus-out');
  await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('mode-fullscreen-focus-in');
  await panelCells(current, 2, anchor);
  assert.deepEqual(live.events(), modeEvents, 'native settings replacements emit no extra start/session_start/reload or execution events');
  assert.deepEqual(traffic(live, 4), modeTraffic, 'native settings replacements preserve four calls/results and five model contexts');
  assert.deepEqual(current.tools.map((tool) => tool.id), initial.tools.map((tool) => tool.id), 'native settings replacements retain the same transcript calls');
  assert.deepEqual(persisted(current), persisted(initial), 'pointer and lifecycle operations preserve exact stored traffic');
  return current;
}

 test('real CLI: built-in bash full commands, preview, resize, theme and same-session controls',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); await terminal.resize(100, 150); return terminal;
    };
    try {
      const live = await start('bash-real', { toolview: true });
      await live.run('bash-real'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, false, 'real built-in bash was not replaced');
      assert.equal(byName(wide, 'bash').length, 4); allBashCards(wide);
      const args = bashArguments(wide);
       assert.ok(args[0].command.includes("<<'TV_EOF'\n  HEREDOC_INDENT\n"));
       for (const tool of wide.tools) for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
         bashCard({ ...tool, lines: tool.tinyLines[width] }, tool.args, { ...wide, width });
         if (width) await assertFits(tool.tinyLines[width], width);
       }
      assert.ok(wide.screen.map(plain).includes(' ┃   HEREDOC_INDENT'), 'supplied two-space heredoc indentation after column-three content origin');
      assert.ok(wide.screen.map(plain).includes(' ┃ HEREDOC_END'));
      assert.equal(lines(byName(wide, 'bash')[2]).filter((row) => /REAL_ROW_\d+/.test(row)).length, 10);
      assert.ok(wide.screen.some((row) => row.includes('… (Click to expand)')));
      assert.ok(!byName(wide, 'bash')[2].lines.some((row) => row.includes('REAL_ROW_11')));
      assert.ok(byName(wide, 'bash')[3].lines.some((row) => row.includes('[error: execution failed]')));
      assert.ok(!byName(wide, 'bash')[3].lines.some((row) => row.includes('[exit code: 7;')), 'built-in transient structuredContent is not a numeric footer source');
      await bashScreenStyle(wide, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, "cat <<'TV_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(wide, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(wide, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(wide, '[error: execution failed]', 'error', 'toolPendingBg');
       // Every panel row is interactive for expandable cards; exterior cells are not.
       await mouseAt(live, wide, 'for i in $(seq 1 11)');
       let current = await live.capture('command-click'); assert.equal(current.tools[2].expanded, true);
       await mouseAt(live, current, 'for i in $(seq 1 11)', { offset: 1 });
       current = await live.capture('gap-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01', { button: 2 });
      current = await live.capture('secondary-click'); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '… (Click to expand)');
      current = await live.capture('hint-click'); allBashCards(current);
      assert.deepEqual(current.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [wide.tools[2].id]);
      assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')));
      await mouseAt(live, current, 'REAL_ROW_11');
      current = await live.capture('output-collapse'); allBashCards(current); assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, 'REAL_ROW_01');
      current = await live.capture('output-expand'); allBashCards(current); assert.equal(current.tools[2].expanded, true);
      await mouseAt(live, current, 'REAL_ROW_11'); await live.capture('recollapsed');
      await live.resize(24, 150); const narrow = await live.capture('narrow'); allBashCards(narrow);
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      // Wide command has no cap and every soft row starts at content origin.
       assert.ok(narrow.tools[1].lines.length > 20);
       assert.ok(narrow.tools[1].lines.length > wide.tools[1].lines.length, 'W-5 content width causes more actual visual rows after resize');
      await live.resize(100, 150); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded)); allBashCards(expanded);
      assert.ok(expanded.screen.some((row) => row.includes('REAL_ROW_11')));
      live.send('\x0f'); await live.settle();
      await live.command('/tv-theme light'); const light = await live.capture('light'); allBashCards(light);
      await bashScreenStyle(light, '$ ', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, "cat <<'TV_EOF'", 'toolTitle', 'toolPendingBg');
      await bashScreenStyle(light, 'HEREDOC_END', 'toolOutput', 'toolPendingBg');
      await bashScreenStyle(light, '… (Click to expand)', 'dim', 'toolPendingBg');
      await bashScreenStyle(light, '[error: execution failed]', 'error', 'toolPendingBg');
       await panelCells(light, 0, "cat <<'TV_EOF'");
       await panelCells(light, 2, 'for i in $(seq 1 11)');
       await panelCells(light, 3, "printf 'REAL_ERROR", { error: true });
       await moveAt(live, 5, panelAt(light, 2, 'for i in $(seq 1 11)').command);
       const lightEnter = await live.capture('pointer-light-enter');
       await panelCells(lightEnter, 2, 'for i in $(seq 1 11)');
       await moveAt(live, 0, panelAt(lightEnter, 2, 'for i in $(seq 1 11)').command);
       const lightLeave = await live.capture('pointer-light-leave'); await panelCells(lightLeave, 2, 'for i in $(seq 1 11)');
       live.send('\x0f'); await live.settle(); const lightExpanded = await live.capture('pointer-light-expanded');
       await moveAt(live, 5, panelAt(lightExpanded, 3, "printf 'REAL_ERROR").command);
       const lightErrorMove = await live.capture('pointer-light-error-move');
       await panelCells(lightErrorMove, 3, "printf 'REAL_ERROR", { error: true });
       live.send('\x0f'); await live.settle();
       await moveAt(live, 0, panelAt(lightErrorMove, 3, "printf 'REAL_ERROR").command);
       await live.capture('pointer-light-end');
       assert.notDeepEqual(light.tools[0].lines, wide.tools[0].lines);
      await live.command('/tv-theme dark');
      const session = wide.session;
      const stock = await start('bash-real-native', { session, workspace: live.work });
      const native = await stock.capture('native');
      assert.deepEqual(persisted(native), persisted(wide), 'same-session native control receives identical actual tool results and command arguments');
      assert.deepEqual(native.tools.map((tool) => tool.content), wide.tools.map((tool) => tool.content));
      assert.ok(native.tools[0].lines.some((row) => row.includes('$ cat')));
      await live.command('/toolview off'); const off = await live.capture('off');
      assert.ok(off.tools.every((tool) => tool.lines.some((row) => row.includes('Took'))), 'live native timing is displayed but not persisted by Pi');
      assert.deepEqual(off.tools.map((tool) => tool.content), native.tools.map((tool) => tool.content));
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live component native rendering restored exactly');
       await live.command('/toolview on');
       // Keep existing live-duration/native controls before the pointer matrix's reload:
       // Pi does not persist native execution durations in a reconstructed component.
       await bashPointerChecks(live, wide);
       const starts = live.events().filter((event) => event.type === 'start').length;
       await live.command('/reload'); await live.event('start', starts + 1);
       const reloaded = await live.capture('reloaded'); allBashCards(reloaded);
      assert.deepEqual(persisted(reloaded), persisted(wide));
      const activity = traffic(live, 4); await live.close();
      const replay = await start('bash-real-replay', { toolview: true, session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), reloaded.tools.map((tool) => tool.lines));
      assert.deepEqual(persisted(resumed), persisted(native));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines), 'same-session native replay restored exactly without unpersisted live duration');
      await replay.command('/toolview on'); allBashCards(await replay.capture('on'));
      const card = await start('bash-real-card', { toolview: true, session, workspace: live.work, flags: ['--toolview-card', 'bash'] });
      const nativeCard = await card.capture('card');
      assert.deepEqual(nativeCard.tools.map((tool) => tool.lines), native.tools.map((tool) => tool.lines));
      const compactOverride = await start('bash-real-compact', { toolview: true, session, workspace: live.work,
        flags: ['--toolview-card', 'bash', '--toolview-compact', 'bash'] });
      const compacted = await compactOverride.capture('compact');
      for (const tool of compacted.tools) compactContent(tool);
      compactOverride.send('\x0f'); await compactOverride.settle(); const overrideExpanded = await compactOverride.capture('expanded');
      stock.send('\x0f'); await stock.settle(); const nativeExpanded = await stock.capture('expanded');
      assert.deepEqual(overrideExpanded.tools.map((tool) => tool.lines), nativeExpanded.tools.map((tool) => tool.lines), 'explicit compact opt-out uses native expanded cards');
      const regular = await start('bash-real-regular', { toolview: true, mode: 'regular', session, workspace: live.work });
      allBashCards(await regular.capture('collapsed'));
      await regular.resize(24, 150); allBashCards(await regular.capture('narrow'));
      await regular.resize(100, 150); regular.send('\x0f'); await regular.settle();
      const regularExpanded = await regular.capture('expanded'); allBashCards(regularExpanded); assert.ok(regularExpanded.tools.every((tool) => tool.expanded));
      writeFileSync(join(artifacts, 'bash-real-coverage.json'), JSON.stringify({ calls: activity.filter((event) => event.type === 'call').length,
        results: activity.filter((event) => event.type === 'result').length, modelContexts: activity.filter((event) => event.type === 'model_context').length,
         builtIn: true, widths: [100, 24, 100], liveComponentWidths: [0, 1, 2, 3, 4, 5, 6, 7, 8],
         pointerViewport: [100, 35], pointerInputs: live.pointerInputs.length,
         selectionObserved: ['pointer-selection-drag', 'pointer-active-selection-click'],
         commands: args, session, modes: ['fullscreen', 'regular'],
        checked: ['heredoc indentation', 'uncapped hard-wrapped commands', '10-row preview', 'real nonzero exit generic footer', 'whole-panel command/gap/output/hint/border/inside/right-edge/top/bottom/footer clicks', 'exterior/separator/nonexpandable/secondary guards', 'actual SGR selection drag/double-click guard and public selection observation', 'native wheel scrolling', 'no-hover native SGR move/enter/margin/editor/focus leave/transfer with strictly steady neutral paint', 'steady neutral paint across resize/off/on/reload and re-entry', 'native /settings fullscreen→regular→fullscreen renderer replacement with retained traffic and no lifecycle events', 'regular replacement Ctrl+O expand/collapse and complete independent body oracle', 'steady neutral panel cells across native mode switches and fullscreen SGR enter/margin/focus leave', 'Ctrl+O', 'dark/light semantic/steady-neutral-background/normal-and-error-border cells', 'off/on/reload/replay', 'native-card and compact precedence', 'identical actual session args/results'] }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

 test('real CLI: gated actual built-in bash streaming and argument pending',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const live = new PiTerminal('bash-stream', { toolview: true });
    try {
      await live.ready(); await live.resize(100, 120);
      live.send('run bash-stream\r'); await live.event('provider_gate');
      const pending = await live.capture('arguments-pending', { animated: true });
      assert.equal(pending.bashShape, false);
      assert.ok(pending.tools[0].lines.some((row) => plain(row).includes('$ for i')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('… (Click')));
      assert.ok(!pending.tools[0].lines.some((row) => plain(row).includes('[error:')));
      await bashScreenStyle(pending, '$ ', 'dim', 'toolPendingBg');
      writeFileSync(join(live.output, 'provider-go'), 'go');
      await until(() => existsSync(join(live.output, 'shell-ready')), 'actual shell emitted 12 rows and reached gate');
      await until(() => live.events().some((event) => event.type === 'execution_update' && JSON.stringify(event.partialResult).includes('LIVE_ROW_12')), 'real built-in partial update');
      let streaming = await live.capture('partial', { animated: true }); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].content[0].text.includes('LIVE_ROW_12'), true);
      assert.ok(!streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await bashScreenStyle(streaming, 'LIVE_ROW_01', 'toolOutput', 'toolPendingBg');
      await mouseAt(live, streaming, '… (Click to expand)', { animated: true });
      streaming = await live.capture('partial-expanded', { animated: true }); allBashCards(streaming, { partial: true });
      assert.equal(streaming.tools[0].expanded, true); assert.ok(streaming.screen.some((row) => row.includes(' LIVE_ROW_12')));
      await live.resize(24, 120, true); const narrow = await live.capture('partial-narrow', { animated: true }); allBashCards(narrow, { partial: true });
      await live.resize(100, 120, true); streaming = await live.capture('partial-wide', { animated: true });
      await mouseAt(live, streaming, 'LIVE_ROW_12', { animated: true });
      const collapsed = await live.capture('partial-collapsed', { animated: true }); assert.equal(collapsed.tools[0].expanded, false);
      writeFileSync(join(live.output, 'shell-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final);
      assert.ok(final.tools[0].content[0].text.includes('LIVE_FINAL'));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('final-expanded'); allBashCards(expanded);
      assert.equal(expanded.tools[0].lines.filter((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_ROW_01').length, 1, 'overlapping built-in snapshots were not appended');
      assert.ok(expanded.screen.some((row) => plain(row).replace(/^ ┃ /u, '').trim() === 'LIVE_FINAL'));
      const observed = traffic(live, 1);
      writeFileSync(join(artifacts, 'bash-stream-coverage.json'), JSON.stringify({ builtIn: true,
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        updates: live.events().filter((event) => event.type === 'execution_update').length,
        gates: ['provider-go', 'shell-ready', 'shell-final'], snapshots: ['arguments pending', '12-row actual partial', 'expanded partial', '24-column partial', 'final'],
        checked: ['pending theme', 'partial output mouse expansion/collapse', 'resize recomputes hit regions', 'final replaces overlapping snapshots', 'Ctrl+O'] }, null, 2));
    } finally { await live.close(); live.dispose(); }
  });

 test('real CLI: isolated opt-in representative bash metadata, comments and output boundaries',
  { skip: stockOnly, timeout: 90000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 240); return terminal;
    };
    try {
      const live = await start('bash-shapes'); await live.run('bash-shapes'); const wide = await live.capture('wide');
      assert.equal(wide.bashShape, true); allBashCards(wide);
      const tools = byName(wide, 'bash'); assert.equal(tools.length, 14);
      assert.ok(tools[0].lines.some((row) => row.includes('# Representative task description')));
      assert.ok(tools[0].lines.some((row) => row.includes('# Running in ' + resolve(wide.cwd, '../other/./dir'))));
      for (const text of ['(no output)', 'Background task started: task-id-123', '[exit code: 99]', 'Command exited with code 77'])
        assert.ok(tools[0].lines.some((row) => row.includes(text)), `returned literal preserved: ${text}`);
      assert.equal(tools[1].lines.filter((row) => stripVTControlCharacters(row).slice(3, -2).trim()).length, 1, 'whitespace-only output and equivalent cwd produce command only');
      assert.ok(!tools[2].lines.some((row) => row.includes('Running in')), 'absolute current cwd equivalent produces no comment');
      assert.ok(!tools[2].lines.some((row) => row.includes('Click to expand')), 'exactly ten visual output rows have no hint');
      assert.ok(tools[3].lines.some((row) => row.includes('Click to expand')), 'eleven visual output rows have hint');
      assert.ok(!tools[4].lines.some((row) => row.includes('Click to expand')), '221 characters wrap into three visual rows at 100');
      for (const index of [10, 11, 12, 13]) assert.ok(!tools[index].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')), 'zero/string/null/transient status has no footer');
      await bashScreenStyle(wide, '# Representative task description', 'muted', 'toolPendingBg');
      await bashScreenStyle(wide, '[exit code: 7]', 'error', 'toolPendingBg');
      await mouseAt(live, wide, '# Representative task description'); let current = await live.capture('comment-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '# Running in', { offset: 1 }); current = await live.capture('comment-gap-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await mouseAt(live, current, '[exit code: 7]'); current = await live.capture('footer-click');
      assert.ok(current.tools.every((tool) => !tool.expanded));
      await live.resize(24, 240); const narrow = await live.capture('narrow'); allBashCards(narrow);
      assert.ok(narrow.tools[4].lines.some((row) => row.includes('… (Click')), 'more than ten W-5 visual output rows use a ten-row preview; allBashCards independently checks the complete shortened hint');
      for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      await live.resize(100, 240); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded'); allBashCards(expanded);
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.tools[3].lines.some((row) => row.includes('SHAPE_ROW_11')));
      live.send('\x0f'); await live.settle();
      const native = await start('bash-shapes-native', { toolview: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); assert.deepEqual(persisted(control), persisted(wide));
      await live.command('/toolview off'); const off = await live.capture('off');
      assert.deepEqual(off.tools.map((tool) => tool.content), control.tools.map((tool) => tool.content));
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'same live native fixture rendering restored exactly');
      await live.command('/toolview on');
      const observed = traffic(live, 14);
      const replay = await start('bash-shapes-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'details footer is stable live/replay; transient structuredContent intentionally ignored');
      assert.deepEqual(persisted(resumed), persisted(wide));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off');
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'same-session fixture native replay restored exactly');
      await replay.command('/toolview on');
      // Independent invocation for partial/final replacement, never an installed AFT execution.
      const stream = await start('bash-shape-stream'); stream.send('run bash-shape-stream\r'); await stream.event('shape_gate');
      let partial = await stream.capture('partial-one', { animated: true }); allBashCards(partial, { partial: true });
      assert.ok(!partial.tools[0].lines.some((row) => row.includes('[exit code:') || row.includes('[error:')));
      await bashScreenStyle(partial, 'OLD_PARTIAL', 'toolOutput', 'toolPendingBg');
       await mouseAt(stream, partial, 'Streaming comment', { animated: true });
       partial = await stream.capture('stream-comment-click', { animated: true }); assert.equal(partial.tools[0].expanded, true);
       await mouseAt(stream, partial, 'Streaming comment', { offset: 1, animated: true });
       partial = await stream.capture('stream-comment-gap-collapse', { animated: true }); assert.equal(partial.tools[0].expanded, false);
       await mouseAt(stream, partial, '… (Click to expand)', { animated: true });
      partial = await stream.capture('partial-expanded', { animated: true }); allBashCards(partial, { partial: true }); assert.equal(partial.tools[0].expanded, true);
      writeFileSync(join(stream.output, 'shape-next'), 'go'); await stream.event('shape_gate', 2);
      const replacement = await stream.capture('partial-two', { animated: true }); allBashCards(replacement, { partial: true });
      assert.ok(!replacement.tools[0].lines.some((row) => row.includes('OLD_PARTIAL') || row.includes('SHAPE_ROW_')));
      assert.ok(replacement.tools[0].lines.some((row) => row.includes('REPLACEMENT_PARTIAL')));
      writeFileSync(join(stream.output, 'shape-final'), 'go'); await stream.event('agent_end');
      const final = await stream.capture('final'); allBashCards(final);
      assert.deepEqual(final.tools[0].content, [{ type: 'text', text: 'FINAL_ONLY' }]);
      assert.ok(!final.tools[0].lines.some((row) => row.includes('PARTIAL')));
      await bashScreenStyle(final, '[exit code: 7; error: execution failed]', 'error', 'toolPendingBg');
      traffic(stream, 1);
      writeFileSync(join(artifacts, 'bash-shapes-coverage.json'), JSON.stringify({ installedAFT: false, optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1',
        calls: observed.filter((event) => event.type === 'call').length, results: observed.filter((event) => event.type === 'result').length,
        streamCalls: 1, streamUpdates: stream.events().filter((event) => event.type === 'execution_update').length,
        cases: bashArguments(wide).map((args) => args.fixtureCase), widths: [100, 24, 100],
        checked: ['description/workdir comments', 'equivalent cwd omission', 'whitespace-only and interior blanks', 'literal task/status text', '10/11 visual rows',
          'structured persisted status combinations', 'transient structuredContent ignored', 'nonexpandable comments/gaps/footer ignored; streaming expandable comment/gap toggle', 'stream snapshots replace', 'partial footer suppressed', 'final generic error footer', 'native off/replay data identity'] }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: isolated bash presentation exceptions preserve exact traffic',
  { skip: stockOnly, timeout: 150000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 360); return terminal;
    };
    const row = (count) => Array.from({ length: count }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`);
    // Fresh literal fixture expectations: these checks do not derive expected traffic from the layout oracle.
    const cases = [
      ['suffix-match', 'BODY\n \t\n[exit code: 7]\n\n \t', 7, false],
      ['suffix-mismatch', 'BODY\n\n[exit code: 8]', 7, false],
      ['suffix-no-gap', 'BODY\n[exit code: 7]', 7, false],
      ['suffix-combined', 'BODY\n\n[exit code: -2; error: execution failed]', -2, true],
      ['suffix-error-only', 'BODY\n\n[error: execution failed]', undefined, true],
      ['suffix-error-mismatch', 'BODY\n\n[exit code: 7]', 7, true],
      ['suffix-success', 'BODY\n\n[exit code: 0]', 0, false],
      ['suffix-unknown', 'BODY\n\n[exit code: 7]', undefined, false],
      ['suffix-string', 'BODY\n\n[exit code: 7]', '7', false],
      ['suffix-indent', 'BODY\n\n [exit code: 7]', 7, false],
      ['suffix-spaces', 'BODY\n\n[exit code: 7] ', 7, false],
      ['suffix-fragment', 'BODY\n\nPREFIX [exit code: 7]', 7, false],
      ['suffix-nonterminal', 'BODY\n\n[exit code: 7]\nAFTER_SUFFIX', 7, false],
      ['suffix-double', 'BODY\n\n[exit code: 7]\n\n[exit code: 7]', 7, false],
      ['preview-one-blank', row(9).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-two-blanks', row(9).join('\n') + '\n\n \t\nHIDDEN_TAIL', undefined, false],
      ['preview-interior', row(3).join('\n') + '\n\n' + row(5).join('\n') + '\n\nHIDDEN_TAIL', undefined, false],
      ['preview-empty', ' '.repeat(1100) + 'HIDDEN_TAIL', undefined, false],
      ['suffix-deep', row(9).join('\n') + '\n\nEXTRA_CONTENT\nHIDDEN_TAIL\n\n[exit code: 7]', 7, false],
      ['suffix-only', '\n[exit code: 7]', 7, false],
    ];
    const body = (tool) => {
      const rows = tool.lines.map(stripVTControlCharacters);
      const top = rows.findIndex((line) => line.includes('┃'));
      return rows.slice(top + 1, -1).map((line) => line.slice(3, -2));
    };
    const byCase = (dump, name) => {
      const index = cases.findIndex(([fixtureCase]) => fixtureCase === name);
      assert.ok(index >= 0); return byName(dump, 'bash')[index];
    };
    const literalCount = (dump, name, literal, count) => assert.equal(
      body(byCase(dump, name)).filter((line) => line.includes(literal)).length, count, `${name}: exact visible count of ${literal}`);
    const identity = (actual, baseline, sessionBytes) => {
      assert.deepEqual(actual.branch, baseline.branch, 'complete branch remains byte-value exact');
      assert.deepEqual(persisted(actual), persisted(baseline), 'all persisted calls/results remain exact');
      assert.deepEqual(actual.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })),
        baseline.tools.map(({ id, args, content, details, isError }) => ({ id, args, content, details, isError })), 'live raw tool state remains exact');
      assert.equal(readFileSync(actual.session, 'utf8'), sessionBytes, 'saved session bytes unchanged by presentation');
    };
    const previewChecks = (dump) => {
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(dump, name));
        const hint = rows.findIndex((line) => line.startsWith('… (Click'));
        assert.ok(hint > 0, `${name}: overflow hint remains present`);
        assert.ok(rows[hint - 1].trim(), `${name}: no whitespace-only preview end before hint`);
        const first = rows.findIndex((line) => line.trimEnd() === 'SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5)] : row(9);
        assert.deepEqual(rows.slice(first, hint).map((line) => line.trimEnd()), expected, `${name}: nine rows, interior blanks preserved, no backfill`);
        assert.ok(!rows.some((line) => /HIDDEN_TAIL|EXTRA_CONTENT/.test(line)), `${name}: hidden later rows stay hidden`);
      }
      const empty = body(byCase(dump, 'preview-empty')).map((line) => line.trimEnd());
      const emptyHint = empty.findIndex((line) => line.startsWith('… (Click'));
      const commandRows = Math.ceil('$ shape preview-empty'.length / bashGeometry(dump.width).content);
      assert.equal(emptyHint, commandRows + 1, 'all-whitespace preview retains only the synthetic output section separator before hint');
      assert.equal(empty[emptyHint - 1], '');
      assert.ok(!empty.some((line) => line.includes('HIDDEN_TAIL')), 'empty preview never backfills the hidden nonblank row');
    };
    try {
      const live = await start('bash-shape-exceptions'); await live.run('bash-shape-exceptions');
      const wide = await live.capture('wide'); assert.equal(wide.bashShape, true); allBashCards(wide);
      assert.equal(wide.tools.length, 20);
      const observed = traffic(live, 20), sessionBytes = readFileSync(wide.session, 'utf8');
      const rawResults = cases.map(([, text, code, isError]) => ({ name: 'bash', content: [{ type: 'text', text }],
        ...(code === undefined ? {} : { details: { exit_code: code } }), isError }));
      const resultEvents = observed.filter((event) => event.type === 'result').map(({ type, ...result }) => result);
      assert.deepEqual(resultEvents, rawResults, 'every original output, trailing space, separator and metadata reaches tool_result exactly');
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        cases.map(([fixtureCase]) => ({ command: 'shape ' + fixtureCase, fixtureCase })), 'only harmless unique isolated commands are requested');
      observed.filter((event) => event.type === 'model_context').forEach((event, index) =>
        assert.deepEqual(event.results, rawResults.slice(0, index), `provider context ${index}: exact original cumulative results`));
      assert.deepEqual(persisted(wide).filter((entry) => entry.role === 'toolResult'),
        rawResults.map(({ name, details, ...result }) => ({ role: 'toolResult', toolName: name, ...result, details })), 'saved messages retain original suffixes and blanks');
      for (const name of ['suffix-match', 'suffix-combined']) {
        const footer = name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]';
        literalCount(wide, name, footer, 1);
        assert.deepEqual(body(byCase(wide, name)).map((line) => line.trimEnd()), ['$ shape ' + name, '', 'BODY', '', footer], 'only duplicated terminal block disappears');
      }
      literalCount(wide, 'suffix-only', '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-only')).map((line) => line.trimEnd()),
        ['$ shape suffix-only', '', '[exit code: 7]'], 'suffix-only output becomes an absent output section, not an extra footer');
      for (const name of ['suffix-no-gap', 'suffix-indent', 'suffix-spaces', 'suffix-fragment', 'suffix-nonterminal', 'suffix-double'])
        literalCount(wide, name, '[exit code: 7]', 2);
      literalCount(wide, 'suffix-mismatch', '[exit code: 8]', 1);
      literalCount(wide, 'suffix-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-only', '[error: execution failed]', 2);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7]', 1);
      literalCount(wide, 'suffix-error-mismatch', '[exit code: 7; error: execution failed]', 1);
      literalCount(wide, 'suffix-success', '[exit code: 0]', 1);
      for (const name of ['suffix-unknown', 'suffix-string', 'suffix-deep']) literalCount(wide, name, '[exit code: 7]', 1);
      assert.deepEqual(body(byCase(wide, 'suffix-no-gap')).map((line) => line.trimEnd()),
        ['$ shape suffix-no-gap', '', 'BODY', '[exit code: 7]', '', '[exit code: 7]'], 'missing separator preserves literal');
      previewChecks(wide);
      await bashScreenStyle(wide, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      for (const theme of ['light', 'dark']) {
        await live.command('/tv-theme ' + theme); const themed = await live.capture('theme-' + theme);
        allBashCards(themed); identity(themed, wide, sessionBytes);
        await bashScreenStyle(themed, '[exit code: -2; error: execution failed]', 'error', 'toolPendingBg');
      }
      await live.resize(24, 360); const narrow = await live.capture('narrow'); allBashCards(narrow); previewChecks(narrow);
      identity(narrow, wide, sessionBytes); for (const tool of narrow.tools) await assertFits(tool.lines, 24);
      live.send('\x0f'); await live.settle(); const narrowExpanded = await live.capture('narrow-expanded'); allBashCards(narrowExpanded);
      assert.ok(narrowExpanded.tools.every((tool) => tool.expanded)); identity(narrowExpanded, wide, sessionBytes);
      await live.resize(100, 360); const expanded = await live.capture('expanded'); allBashCards(expanded); identity(expanded, wide, sessionBytes);
      for (const name of ['suffix-match', 'suffix-combined']) literalCount(expanded, name,
        name === 'suffix-match' ? '[exit code: 7]' : '[exit code: -2; error: execution failed]', 1);
      for (const name of ['preview-one-blank', 'preview-two-blanks', 'preview-interior', 'suffix-deep']) {
        const rows = body(byCase(expanded, name)).map((line) => line.trimEnd());
        const first = rows.indexOf('SHAPE_ROW_01');
        const expected = name === 'preview-interior' ? [...row(3), '', ...row(5), '', 'HIDDEN_TAIL'] :
          name === 'suffix-deep' ? [...row(9), '', 'EXTRA_CONTENT', 'HIDDEN_TAIL', '', '[exit code: 7]'] :
          [...row(9), '', ...(name === 'preview-two-blanks' ? [''] : []), 'HIDDEN_TAIL'];
        assert.deepEqual(rows.slice(first), expected, `${name}: expansion retains all internal blank rows and hidden text`);
      }
      const emptyExpanded = body(byCase(expanded, 'preview-empty'));
      assert.equal(emptyExpanded.length, 14, 'expanded whitespace-prefix output retains all twelve visual output rows plus command and separator');
      assert.ok(emptyExpanded.slice(2, -1).every((line) => !line.trim()), 'eleven expanded whitespace-only content rows are not trimmed');
      assert.equal(emptyExpanded.at(-1).trim(), 'HIDDEN_TAIL');
      live.send('\x0f'); await live.settle(); const back = await live.capture('wide-again');
      assert.deepEqual(back.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); identity(back, wide, sessionBytes);
      await live.command('/toolview off'); const off = await live.capture('off'); identity(off, wide, sessionBytes);
      await live.command('/toolview on'); allBashCards(await live.capture('on'));
      await live.command('/toolview off'); const offAgain = await live.capture('off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), off.tools.map((tool) => tool.lines), 'live native renderer restored without normalization');
      const starts = live.events().filter((event) => event.type === 'start').length;
      await live.command('/toolview on'); await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await live.capture('reloaded'); allBashCards(reloaded); identity(reloaded, wide, sessionBytes);
      assert.deepEqual(reloaded.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines), 'same-session reload preserves exception presentation');
      const native = await start('bash-shape-exceptions-native', { toolview: false, session: wide.session, workspace: live.work });
      const control = await native.capture('native'); identity(control, wide, sessionBytes);
      await live.command('/toolview off'); const reloadedOff = await live.capture('reloaded-off'); identity(reloadedOff, wide, sessionBytes);
      assert.deepEqual(reloadedOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'reloaded native output matches stock history byte-for-byte');
      const replay = await start('bash-shape-exceptions-replay', { session: wide.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); identity(resumed, wide, sessionBytes);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      await replay.command('/toolview off'); const replayOff = await replay.capture('off'); identity(replayOff, wide, sessionBytes);
      assert.deepEqual(replayOff.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines), 'disabled same-session replay restores exact native rendering');
      for (const terminal of [native, replay]) for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(terminal.events().filter((event) => event.type === type).length, 0, `history ${type} count remains zero`);
      assert.deepEqual(traffic(live, 20), observed, 'resize/theme/Ctrl+O/off/on/reload never rerun tool or provider');
      assert.equal(readFileSync(wide.session, 'utf8'), sessionBytes);
      writeFileSync(join(artifacts, 'bash-shape-exceptions-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        historyCalls: [native, replay].reduce((sum, terminal) => sum + terminal.events().filter((event) => event.type === 'call').length, 0),
        cases: cases.map(([name]) => name), widths: [100, 24, 100], themes: ['dark', 'light', 'dark'],
        checked: ['exact metadata-only terminal suffix', 'no-gap/mismatch/error-only/string/unknown/success literals retained',
          'one trailing block only', 'unwrapped footer comparison at narrow width', 'preview end blanks removed without backfill',
          'preview interior blanks and expanded blank rows retained', 'empty preview keeps only synthetic section separator', 'strict raw tool/session/branch/model/calls/context identity',
          'Ctrl+O', 'footer semantic cells', 'off/on/reload/native/history replay'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution', 'production bounded wrapping checked by parent unit tests'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

test('real CLI: isolated bash presentation exceptions partial-to-final gate',
  { skip: stockOnly, timeout: 60000 }, async () => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { toolview: true, extraEnv: { TOOLVIEW_TEST_BASH_SHAPE: '1' }, ...options });
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const raw = Array.from({ length: 9 }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, '0')}`).join('\n') + '\n\n[exit code: 7]';
    const original = { content: [{ type: 'text', text: raw }], details: { exit_code: 7 }, isError: false };
    const rawIdentity = (dump) => assert.deepEqual(dump.tools.map(({ content, details, isError }) => ({ content, details, isError })), [original]);
    const visibleCount = (dump) => dump.tools[0].lines.filter((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd() === '[exit code: 7]').length;
    try {
      const live = await start('bash-shape-exception-stream'); live.send('run bash-shape-exception-stream\r');
      await live.event('shape_exception_gate');
      const partial = await live.capture('partial', { animated: true }); allBashCards(partial, { partial: true }); rawIdentity(partial);
      assert.equal(partial.tools[0].partial, true); assert.equal(partial.tools[0].expanded, false);
      const preview = partial.tools[0].lines.map(plain), hint = preview.findIndex((line) => line.includes('… (Click'));
      assert.ok(hint > 0); assert.ok(preview[hint - 1].includes('SHAPE_ROW_09'), 'partial preview trims blank tenth row without backfill');
      assert.equal(visibleCount(partial), 0, 'partial suffix is hidden by preview, not rendered as a synthesized status');
      await mouseAt(live, partial, '… (Click to expand)', { animated: true });
      const partialExpanded = await live.capture('partial-expanded', { animated: true }); allBashCards(partialExpanded, { partial: true }); rawIdentity(partialExpanded);
      assert.equal(partialExpanded.tools[0].expanded, true); assert.equal(visibleCount(partialExpanded), 1, 'expanded partial retains exact output suffix');
      const partialRows = partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line).slice(3, -2).trimEnd());
      assert.equal(partialRows[partialRows.indexOf('[exit code: 7]') - 1], '', 'partial retains the output blank separator');
      await bashScreenStyle(partialExpanded, '[exit code: 7]', 'toolOutput', 'toolPendingBg');
      await live.resize(24, 120, true); const narrow = await live.capture('partial-narrow', { animated: true });
      allBashCards(narrow, { partial: true }); rawIdentity(narrow); assert.equal(narrow.tools[0].expanded, true);
      await live.resize(100, 120, true);
      writeFileSync(join(live.output, 'shape-exception-final'), 'go'); await live.event('agent_end');
      const final = await live.capture('final'); allBashCards(final); rawIdentity(final);
      assert.equal(final.tools[0].partial, false); assert.equal(final.tools[0].expanded, true);
      assert.equal(visibleCount(final), 1, 'final matching status appears exactly once, as metadata footer');
      assert.deepEqual(final.tools[0].lines.map((line) => stripVTControlCharacters(line)),
        partialExpanded.tools[0].lines.map((line) => stripVTControlCharacters(line)), 'partial literal and final synthesized footer have identical plain rows');
      await bashScreenStyle(final, '[exit code: 7]', 'error', 'toolPendingBg');
      // A local hint click does not change Pi's global Ctrl+O setting (initially collapsed).
      // First synchronize global expansion, then toggle global collapse; assert both actual states.
      live.send('\x0f'); await live.settle(); const globalExpanded = await live.capture('final-global-expanded');
      allBashCards(globalExpanded); rawIdentity(globalExpanded); assert.equal(globalExpanded.tools[0].expanded, true);
      live.send('\x0f'); await live.settle(); const collapsed = await live.capture('final-collapsed'); allBashCards(collapsed); rawIdentity(collapsed);
      assert.equal(collapsed.tools[0].expanded, false); assert.equal(visibleCount(collapsed), 1);
      assert.ok(!collapsed.tools[0].lines.some((line) => line.includes('Click to expand')), 'final dedup leaves nine output rows: no overflow hint');
      await live.resize(24, 120); const narrowFinal = await live.capture('final-narrow'); allBashCards(narrowFinal); rawIdentity(narrowFinal);
      assert.ok(!narrowFinal.tools[0].lines.some((line) => line.includes('… (Click')), 'dedup uses logical unwrapped suffix at 24 columns too');
      await live.resize(100, 120);
      const observed = traffic(live, 1);
      assert.deepEqual(observed.filter((event) => event.type === 'call').map((event) => event.input),
        [{ command: 'shape exception-stream', fixtureCase: 'exception-stream' }]);
      assert.deepEqual(observed.filter((event) => event.type === 'result').map(({ type, name, ...result }) => result), [original]);
      assert.deepEqual(observed.filter((event) => event.type === 'model_context').map((event) => event.results),
        [[], [{ name: 'bash', ...original }]], 'final model context receives exact original suffix and blank');
      const updates = live.events().filter((event) => event.type === 'execution_update');
      assert.equal(updates.length, 1); assert.deepEqual(updates[0].partialResult, original, 'one exact partial snapshot, not concatenated output');
      assert.deepEqual(persisted(final).filter((entry) => entry.role === 'toolResult'), [{ role: 'toolResult', toolName: 'bash', ...original }]);
      const sessionBytes = readFileSync(final.session, 'utf8');
      const replay = await start('bash-shape-exception-stream-replay', { session: final.session, workspace: live.work });
      const resumed = await replay.capture('replay'); allBashCards(resumed); rawIdentity(resumed);
      assert.deepEqual(resumed.tools.map((tool) => tool.lines), collapsed.tools.map((tool) => tool.lines));
      assert.deepEqual(resumed.branch, final.branch); assert.deepEqual(persisted(resumed), persisted(final));
      assert.equal(readFileSync(final.session, 'utf8'), sessionBytes, 'history did not rewrite original result');
      for (const type of ['call', 'result', 'model_context', 'provider_error']) assert.equal(replay.events().filter((event) => event.type === type).length, 0);
      assert.deepEqual(traffic(live, 1), observed);
      writeFileSync(join(artifacts, 'bash-shape-exception-stream-coverage.json'), JSON.stringify({ installedAFT: false,
        optIn: 'TOOLVIEW_TEST_BASH_SHAPE=1', calls: observed.filter((event) => event.type === 'call').length,
        results: observed.filter((event) => event.type === 'result').length, modelContexts: observed.filter((event) => event.type === 'model_context').length,
        updates: updates.length, replayCalls: replay.events().filter((event) => event.type === 'call').length,
        gates: ['shape-exception-final'], widths: [100, 24, 100],
        checked: ['unchanged partial/final original content', 'partial suffix retained with output color', 'final dedup with error color',
          'blank preview edge trimmed while partial', 'real hint click', 'final nine-row no-overflow preview',
          'narrow unwrapped match', 'Ctrl+O', 'exact model/session/history identity'],
        limitations: ['isolated deterministic metadata fixture, not installed AFT execution'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });

// Width regression: only ANSI-parsed physical cells are the display authority.
// Do not reuse the manual tool.render(viewportWidth) geometry/content oracle.
async function actualCommandCells(dump, commands, { mode, scrollbar }) {
  const panels = [];
  // An always-visible native scrollbar also uses ┃, outside the tool allocation.
  const reserved = mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0;
  const hasCardBorder = (row) => row.slice(0, row.length - reserved).some((cell) => cell?.text === '┃');
  for (let y = 0; y < dump.cells.length; y++) {
    if (!hasCardBorder(dump.cells[y])) continue;
    const top = y;
    while (y + 1 < dump.cells.length && hasCardBorder(dump.cells[y + 1])) y++;
    panels.push({ top, bottom: y });
  }
  assert.equal(panels.length, commands.length, 'every command owns exactly one complete displayed panel');
  const background = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const cellText = (cell) => cell.text || ' ';
  const observations = [];
  for (const [index, { top, bottom }] of panels.entries()) {
    const padding = dump.cells[top];
    const left = padding.findIndex((cell) => cell.text === '┃');
    let panelEnd = left + 1; // stripe background is default, not panel paint
    while (panelEnd < padding.length && padding[panelEnd].bgMode === background.bgMode && padding[panelEnd].bg === background.bg) panelEnd++;
    // Observe the painted end, then add the contract's one unpainted exterior cell.
    // Fullscreen 'always' reserves a scrollbar column; regular/auto do not.
    const allocated = panelEnd + 1;
    assert.equal(allocated, dump.cells[top].length - (mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0),
      'observed frame width matches actual host allocation, not the manual dump width');
    assert.equal(left, 1, 'exact one-cell exterior-left margin');
    const origin = left + 2, contentWidth = panelEnd - 1 - origin;
    assert.equal(origin, 3, 'one border cell plus one inside-left cell');
    assert.equal(contentWidth, allocated - 5, 'observed content width excludes both inner and exterior paddings');
    const command = commands[index];
    assert.match(command, /^[\x20-\x7e\n]*$/u, 'this independent oracle is deliberately ASCII-only');
    const logical = ('$ ' + command).split('\n');
    const expected = logical.flatMap((line) => line.length ? Array.from({ length: Math.ceil(line.length / contentWidth) },
      (_, row) => line.slice(row * contentWidth, (row + 1) * contentWidth)) : ['']);
    assert.ok(top > 0 && bottom + 1 < dump.cells.length, 'all command rows and complete panel padding are visible');
    assert.ok(bottom > top + expected.length, 'panel includes every command row and bottom padding');
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < allocated; x++) {
        const cell = dump.cells[y][x];
        if (x === 0 || x === allocated - 1) {
          assert.equal(cellText(cell), ' ', `exact blank exterior (${x},${y})`);
          assert.equal(cell.bgMode, 0, `unpainted exterior (${x},${y})`);
        } else if (x === left) {
          assert.equal(cell.bgMode, 0, `default stripe background (${x},${y})`);
        } else {
          assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: background.bg, bgMode: background.bgMode },
            `panel physical background (${x},${y})`);
        }
      }
      assert.equal(dump.cells[y][left].text, '┃', 'one border on every physical row');
      for (const x of [left + 1, panelEnd - 1]) assert.equal(cellText(dump.cells[y][x]), ' ', 'exact inside-left/right padding');
    }
    for (const y of [top, bottom]) assert.equal(dump.cells[y].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'full top/bottom content padding');
    const actual = expected.map((row, offset) => {
      const cells = dump.cells[top + 1 + offset];
      const region = cells.slice(origin, panelEnd - 1);
      assert.ok(region.every((cell) => cell.width === 1), 'ASCII command occupies one physical cell per column');
      assert.equal(region.map(cellText).join(''), row.padEnd(contentWidth), 'every displayed command row, including whitespace and right padding');
      return region.slice(0, row.length).map(cellText).join('');
    });
    assert.equal(dump.cells[top + expected.length + 1].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'immediately after complete command is its blank output separator or bottom padding');
    // Restore only known logical newline boundaries; never trim or delete command whitespace.
    let cursor = 0;
    const reconstructed = logical.map((line) => actual.slice(cursor, cursor += Math.max(1, Math.ceil(line.length / contentWidth))).join('')).join('\n');
    assert.equal(reconstructed, '$ ' + command, 'all displayed command chars reconstructed exactly: no missing/duplicated chars');
    observations.push({ allocatedWidth: allocated, contentWidth, origin, commandChars: command.length,
      commandRows: actual.length, displayed: actual, reconstructed, equality: true });
  }
  return observations;
}

test('real CLI: actual-screen complete command width regression', { skip: stockOnly, timeout: 120000 }, async () => {
  const terminals = [], captures = [];
  const originalPython = "python3 -c \"from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))\" && node --check /tmp/neon-blocks-check.js";
  const commands = ["printf '" + 'LONGWORD'.repeat(30) + "'", originalPython.replaceAll('/tmp/neon-blocks-check.js', 'neon-blocks-check.js')];
  assert.equal(commands[0].length, 249, 'exact 249 ASCII-char safe built-in longword command');
  const start = async (name, options) => {
    const terminal = new PiTerminal(name, { toolview: true, ...options }); terminals.push(terminal);
    await terminal.ready(); await terminal.resize(100, 150); return terminal;
  };
  const observe = async (terminal, phase, settings) => {
    let baseline;
    for (const width of [100, 24, 140, 100]) {
      await terminal.resize(width, 150);
      const dump = await terminal.capture(`width-${phase}-${width}-${captures.length}`);
      assert.equal(dump.bashShape, false, 'native built-in bash is never replaced');
      assert.deepEqual(byName(dump, 'bash').map((tool) => tool.args.command), commands, 'original executed args remain exact');
      assert.deepEqual(bashArguments(dump).map((args) => args.command), commands, 'persisted commands remain exact');
      const observed = await actualCommandCells(dump, commands, settings);
      captures.push({ phase, mode: settings.mode, scrollbar: settings.scrollbar, viewportWidth: width, commands: observed });
      baseline ??= persisted(dump);
      assert.deepEqual(persisted(dump), baseline, 'resize cannot change persisted content');
    }
    return baseline;
  };
  try {
    for (const settings of [{ mode: 'fullscreen', scrollbar: 'auto' }, { mode: 'fullscreen', scrollbar: 'always' },
      { mode: 'regular', scrollbar: 'auto' }]) {
      const options = { mode: settings.mode, agentSettings: { fullscreenScrollbar: settings.scrollbar } };
      const live = await start(`width-${settings.mode}-${settings.scrollbar}-live`, options);
      writeFileSync(join(live.work, 'index.html'), '<html><script>const neonBlocksCheck = 1;\n</script></html>\n');
      await live.run('bash-width');
      const trafficBefore = traffic(live, 2);
      assert.ok(live.events().filter((event) => event.type === 'result').every((event) => !event.isError), 'both real commands succeed');
      assert.deepEqual(live.events().filter((event) => event.type === 'call').map((event) => event.input.command), commands);
      assert.equal(readFileSync(join(live.work, 'neon-blocks-check.js'), 'utf8'), 'const neonBlocksCheck = 1;\n', 'only owned workspace receives Python output');
      const beforeReplay = await observe(live, 'live', settings);
      assert.deepEqual(traffic(live, 2), trafficBefore, 'width transitions do not execute tools or provider again');
      const session = live.session; await live.close();
      const replay = await start(`width-${settings.mode}-${settings.scrollbar}-replay`, { ...options, session, workspace: live.work });
      const afterReplay = await observe(replay, 'replay', settings);
      assert.deepEqual(afterReplay, beforeReplay, 'same-session replay retains exact arguments/results');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `replay ${type} counter stays zero`);
      await replay.close();
    }
    writeFileSync(join(artifacts, 'actual-command-width-coverage.json'), JSON.stringify({
      originalPythonTextOnly: originalPython, executedCommands: commands,
      originalFixedTmpPathExecuted: false, installedAFTExecuted: false,
      liveInvocations: 3, calls: 6, results: 6, modelContexts: 9, replayInvocations: 3, replayCalls: 0,
      captures, checked: ['physical ASCII command cells', 'exact hardwrap reconstruction preserving whitespace',
        'observed allocated width', 'one inner/exterior cell on each side', 'full panel painting', 'same-session replay', 'resize back'],
    }, null, 2));
  } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
});


// Observable work counters come only from actual /toolview notifications in the live tree.
// pointer-cache-* deliberately avoids the pre-existing alternate-width dump probes.
test('real CLI: render cache work counters and bounded retained memory',
  { skip: stockOnly, timeout: 120000 }, async () => {
    const terminals = [], snapshots = [];
    const start = async (name, options = {}, resizeTall = true) => {
      const terminal = new PiTerminal(name, options); terminals.push(terminal);
      await terminal.ready(); if (resizeTall) await terminal.resize(100, 320); return terminal;
    };
    const observe = async (terminal, name, command = '/toolview cache') => {
      await terminal.command(command);
      const dump = await terminal.capture(`pointer-cache-${name}`);
      const stats = dump.cacheDiagnostics.at(-1);
      assert.ok(stats, 'real cache command produced a JSON notification in the native tree');
      assert.deepEqual(Object.keys(stats).sort(), ['retainedBytes', 'limitBytes', 'entries', 'hits', 'misses', 'builds',
        'evictions', 'skips', 'processHeapUsedBytes', 'processMemoryScope'].sort(), 'diagnostic schema is explicit and bounded');
      for (const key of ['retainedBytes', 'limitBytes', 'entries', 'hits', 'misses', 'builds', 'evictions', 'skips', 'processHeapUsedBytes'])
        assert.ok(Number.isSafeInteger(stats[key]) && stats[key] >= 0, `finite nonnegative diagnostic ${key}`);
      assert.equal(stats.processMemoryScope, 'whole Pi process, not Toolview');
      assert.ok(stats.processHeapUsedBytes > 0, 'process heap is sampled, not attributed to Toolview');
      assert.ok(stats.retainedBytes <= stats.limitBytes, 'retained rendered data never exceeds its current budget');
      assert.ok(stats.entries <= 2048, 'entry count never exceeds its documented bound');
      snapshots.push({ terminal: terminal.output, name, ...stats });
      return { dump, stats };
    };
    const delta = (before, after, builds, label) => {
      assert.equal(after.builds - before.builds, builds, `${label}: exact custom-body builds`);
      assert.equal(after.misses - before.misses, builds, `${label}: each necessary build is one miss`);
      for (const key of ['hits', 'misses', 'builds', 'evictions', 'skips'])
        assert.ok(after[key] >= before[key], `${label}: ${key} remains monotonic`);
      assert.ok(after.hits > before.hits, `${label}: unchanged components actually hit the cache`);
    };
    const identity = (actual, original) => {
      assert.deepEqual(persisted(actual), persisted(original), 'UI probes never change stored arguments/results');
      assert.deepEqual(actual.branch, original.branch, 'commands and diagnostics add no session messages or entries');
      assert.deepEqual(actual.tools.map(({ id, content, details, args }) => ({ id, content, details, args })),
        original.tools.map(({ id, content, details, args }) => ({ id, content, details, args })), 'restored live results and args are exact');
    };
    try {
      const live = await start('cache-performance-live', { toolview: true,
        flags: ['--toolview-cache-mb', '1'], extraEnv: { TOOLVIEW_TEST_CACHE_DIAGNOSTICS: '1' } });
      await live.command('/toolview off');
      await live.run('cache-performance');
      const nativeLive = await live.capture('pointer-cache-native-live-original');
      await live.command('/toolview on');
      const wide = await live.capture('pointer-cache-wide');
      assert.equal(wide.bashShape, false, 'eight commands execute actual built-in bash, never shape mocks');
      assert.equal(wide.tools.length, 11);
      assert.equal(byName(wide, 'bash').length, 8);
      const activity = traffic(live, 11);
      assert.deepEqual(activity.filter((event) => event.type === 'call').map((event) => event.name),
        [...Array(8).fill('bash'), 'read', 'read', 'tv_hidden']);
      assert.ok(activity.filter((event) => event.type === 'result').every((event) => !event.isError));
      allBashCards(wide);
      for (const [index, tool] of byName(wide, 'bash').entries()) {
        const expected = Array.from({ length: 1000 }, (_, row) => `CACHE_OUTPUT_${index}_${String(row + 1).padStart(4, '0')}_ASCII_PAYLOAD`).join('\n') + '\n';
        assert.deepEqual(tool.content, [{ type: 'text', text: expected }], 'all 1000 real output lines remain exact and untruncated');
        assert.equal(tool.lines.filter((row) => plain(row).includes(`CACHE_OUTPUT_${index}_`)).length, 11,
          'command plus first ten output rows only; full-body oracle checks every character');
        assert.ok(!tool.lines.some((row) => row.includes(`CACHE_OUTPUT_${index}_0011_`)), 'eleventh row is hidden, not painted');
      }
      assert.deepEqual(byName(wide, 'tv_hidden')[0].lines, [], 'actual self-shell empty renderer remains hidden');
      for (const tool of byName(wide, 'read')) compactContent(tool);
      await panelCells(wide, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(wide, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      let { stats: previous } = await observe(live, 'warm');
      assert.equal(previous.limitBytes, 1024 * 1024, 'initial string CLI budget is applied');
      assert.equal(previous.entries, 10, 'one latest layout per eight bash and two compact components; hidden contributes none');
      assert.ok(previous.retainedBytes > 0 && previous.builds >= 10);
      for (const name of ['frame-one', 'frame-two', 'frame-three']) {
        const { dump, stats } = await observe(live, name);
        delta(previous, stats, 0, name);
        assert.equal(stats.entries, 10); assert.equal(stats.retainedBytes, previous.retainedBytes);
        assert.deepEqual(dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
        identity(dump, wide); previous = stats;
      }
      live.send('cache editor scratch'); await live.settle();
       const editorScreen = live.screen(); // Do not append a dump command to nonempty editor input.
       writeFileSync(join(live.output, 'pointer-cache-editor.screen.txt'), editorScreen.join('\n'));
       assert.ok(editorScreen.some((row) => row.includes('cache editor scratch')), 'actual native editor changed');
      live.send('\x15'); await live.settle();
      let measured = await observe(live, 'editor-cleared'); delta(previous, measured.stats, 0, 'native editor frames'); previous = measured.stats;
      await moveAt(live, 5, panelAt(measured.dump, 7, 'CACHE_OUTPUT_7_').command);
      measured = await observe(live, 'pointer-motion'); delta(previous, measured.stats, 0, 'native no-hover motion');
      await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_'); previous = measured.stats;

      // Use a genuinely scrollable host viewport, then establish its own warm baseline.
      await live.resize(100, 35);
      const wheel = await observe(live, 'wheel-base');
       const wheelRow = wheel.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
       assert.ok(wheelRow >= 0, 'actual bash command is visible in the small native transcript viewport');
      await sgrAt(live, 5, wheelRow, 64, false);
      assert.notDeepEqual(live.screen(), wheel.dump.screen, 'actual wheel scrolls before any new capture/notification can alter the screen');
      await live.capture('pointer-cache-wheel-scrolled');
      measured = await observe(live, 'wheel-stats'); delta(wheel.stats, measured.stats, 0, 'native wheel frames');
      assert.ok(measured.dump.tools.every((tool) => !tool.expanded));
      await live.resize(100, 320); measured = await observe(live, 'height-restored'); previous = measured.stats;

      // Update only a native component, not its persisted/model result; then exercise reused-object invalidation.
      const chosen = byName(wide, 'bash')[7];
      for (const [operation, marker] of [['replace', 'CACHE_UPDATE_REPLACED'], ['reuse', 'CACHE_UPDATE_REUSED'], ['restore', 'CACHE_OUTPUT_7_0001_ASCII_PAYLOAD']]) {
        await live.command(`/tv-cache-update ${chosen.id} ${operation}`);
        measured = await observe(live, `result-${operation}`);
        delta(previous, measured.stats, 1, `single native updateResult ${operation}`);
        const changed = measured.dump.tools.find((tool) => tool.id === chosen.id);
        assert.ok(changed.lines.some((row) => row.includes(marker)), 'actual rendered body follows the native result update');
        assert.deepEqual(measured.dump.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines),
          wide.tools.filter((tool) => tool.id !== chosen.id).map((tool) => tool.lines), 'every other component remains byte-identical');
        assert.deepEqual(measured.dump.branch, wide.branch, 'isolated native mutation does not touch stored traffic');
        allBashCards(measured.dump); previous = measured.stats;
      }
      identity(measured.dump, wide);
      await live.resize(24, 320); measured = await observe(live, 'narrow');
      delta(previous, measured.stats, 10, 'width resize affects ten custom components once');
      assert.equal(measured.stats.entries, 10, 'width replacement does not retain historical variants');
      allBashCards(measured.dump); for (const tool of measured.dump.tools) await assertFits(tool.lines, 24);
      previous = measured.stats;
      await live.resize(100, 320); measured = await observe(live, 'wide-again');
      delta(previous, measured.stats, 10, 'resize back rebuilds exactly one latest width per component');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;
      await live.command('/tv-theme light'); measured = await observe(live, 'light');
      delta(previous, measured.stats, 10, 'theme invalidation builds each custom component once');
      allBashCards(measured.dump); await panelCells(measured.dump, 7, 'CACHE_OUTPUT_7_');
      await bashScreenStyle(measured.dump, 'CACHE_OUTPUT_7_0010_ASCII_PAYLOAD', 'toolOutput', 'toolPendingBg');
      assert.notDeepEqual(measured.dump.tools[0].lines, wide.tools[0].lines);
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines.map(plain)), wide.tools.map((tool) => tool.lines.map(plain))); previous = measured.stats;
      await live.command('/tv-theme dark'); measured = await observe(live, 'dark'); delta(previous, measured.stats, 10, 'theme restored'); previous = measured.stats;
      const commandRow = measured.dump.screen.findIndex((row) => row.includes('$ for i') && row.includes('CACHE_OUTPUT_7_'));
      assert.ok(commandRow >= 0, 'chosen expandable command is on actual screen');
      await sgrAt(live, 3, commandRow); measured = await observe(live, 'expanded-one');
      delta(previous, measured.stats, 1, 'one real normalized bash click expands only one custom component');
      assert.deepEqual(measured.dump.tools.filter((tool) => tool.expanded).map((tool) => tool.id), [chosen.id]);
      allBashCards(measured.dump);
      assert.ok(measured.dump.screen.some((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD')), 'complete expanded tail appears on physical screen');
      assert.ok(measured.stats.retainedBytes > previous.retainedBytes, 'full expanded rendered data is accounted'); previous = measured.stats;
      const tail = measured.dump.screen.findIndex((row) => row.includes('CACHE_OUTPUT_7_1000_ASCII_PAYLOAD'));
      await sgrAt(live, 3, tail); measured = await observe(live, 'collapsed-one');
      delta(previous, measured.stats, 1, 'whole-panel output click replaces expanded layout with preview');
      assert.deepEqual(measured.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); previous = measured.stats;

      // Command snapshot precedes its requested frame: reduction/clear must already be observable there.
      const tiny = await observe(live, 'tiny-limit', '/toolview cache limit 0.02');
      assert.equal(tiny.stats.limitBytes, Math.floor(0.02 * 1024 * 1024));
      assert.ok(tiny.stats.evictions > previous.evictions, 'limit reduction immediately evicts retained rendered data');
      measured = await observe(live, 'tiny-rendered');
      assert.ok(measured.stats.evictions > tiny.stats.evictions, 'tiny budget exercises real render-time LRU eviction');
      allBashCards(measured.dump); identity(measured.dump, wide);
      const zero = await observe(live, 'zero-limit', '/toolview cache limit 0');
      assert.equal(zero.stats.limitBytes, 0); assert.equal(zero.stats.entries, 0); assert.equal(zero.stats.retainedBytes, 0);
      measured = await observe(live, 'zero-rendered');
      assert.equal(measured.stats.entries, 0); assert.equal(measured.stats.retainedBytes, 0);
      assert.ok(measured.stats.builds > zero.stats.builds && measured.stats.skips > zero.stats.skips, 'zero disables retention, not correct rendering');
      allBashCards(measured.dump); identity(measured.dump, wide);
      await observe(live, 'budget-restored', '/toolview cache limit 1');
      measured = await observe(live, 'budget-warm'); assert.equal(measured.stats.entries, 10); previous = measured.stats;
      const clear = await observe(live, 'clear', '/toolview cache clear');
      assert.equal(clear.stats.entries, 0); assert.equal(clear.stats.retainedBytes, 0);
      assert.equal(clear.stats.builds, previous.builds, 'clear releases data before any next-frame builds');
      measured = await observe(live, 'clear-cold'); delta(previous, measured.stats, 10, 'clear causes exactly one on-demand rebuild per custom component');
      assert.equal(measured.stats.entries, 10); identity(measured.dump, wide);

      const session = wide.session;
      const native = await start('cache-performance-native', { session, workspace: live.work });
      const control = await native.capture('pointer-cache-native');
      assert.deepEqual(control.branch, wide.branch); identity(control, wide);
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(native.events().filter((event) => event.type === type).length, 0, `native replay emits no ${type}`);
      await live.command('/toolview off'); const off = await observe(live, 'off');
      assert.equal(off.stats.entries, 0); assert.equal(off.stats.retainedBytes, 0);
      const nativeRows = off.dump.tools.map((tool) => tool.lines);
      assert.deepEqual(off.dump.tools.map((tool) => tool.lines), nativeLive.tools.map((tool) => tool.lines),
        'off restores the original same-live native bodies byte-for-byte, including real unpersisted timing');
      await live.command('/toolview on'); const on = await observe(live, 'on-cold');
      assert.equal(on.stats.builds, 10, 'new controller starts cold and builds ten custom bodies once');
      assert.equal(on.stats.entries, 10); identity(on.dump, wide);
      assert.deepEqual(on.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines));
      const onWarm = await observe(live, 'on-warm'); delta(on.stats, onWarm.stats, 0, 'reenabled steady frames');
      await live.command('/toolview off'); const offAgain = await live.capture('pointer-cache-off-again');
      assert.deepEqual(offAgain.tools.map((tool) => tool.lines), nativeRows, 'same live native bodies are restored byte-for-byte');
      // Compare reconstructed native bodies with reconstructed native control; neither has unpersisted live durations.
      await live.command('/reload'); await live.command('/toolview off');
      const reloadedNative = await live.capture('pointer-cache-reloaded-native');
      assert.deepEqual(reloadedNative.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines),
        'native history after reload matches same-session stock replay byte-for-byte without normalization');
      identity(reloadedNative, wide);
      await live.command('/toolview on'); const final = await observe(live, 'final'); identity(final.dump, wide);
      assert.deepEqual(traffic(live, 11), activity, 'all editor/pointer/resize/theme/cache commands preserve eleven calls/results and twelve model contexts exactly');
      await live.close();
      const replay = await start('cache-performance-replay', { toolview: true, session, workspace: live.work, flags: ['--toolview-cache-mb', '1'] }, false);
      const resumed = await observe(replay, 'replayed'); identity(resumed.dump, wide);
      assert.equal(resumed.stats.entries, 10);
      assert.deepEqual(resumed.dump.tools.map((tool) => tool.lines), wide.tools.map((tool) => tool.lines)); allBashCards(resumed.dump);
      // Pi asynchronously invalidates its whole tree after startup syntax-grammar loading.
      // Measure an explicit cold epoch instead of attributing all bootstrap work to one frame.
      const replayClear = await observe(replay, 'replay-clear', '/toolview cache clear');
      assert.equal(replayClear.stats.entries, 0); assert.equal(replayClear.stats.retainedBytes, 0);
      const replayCold = await observe(replay, 'replay-cold');
      delta(replayClear.stats, replayCold.stats, 10, 'explicit replay cold epoch builds exactly ten bodies once');
      assert.equal(replayCold.stats.entries, 10); identity(replayCold.dump, wide);
      const replayWarm = await observe(replay, 'replay-warm'); delta(replayCold.stats, replayWarm.stats, 0, 'actual same-session replay warm frames');
      for (const type of ['call', 'result', 'model_context', 'provider_error'])
        assert.equal(replay.events().filter((event) => event.type === type).length, 0, `Toolview replay emits no ${type}`);
      writeFileSync(join(artifacts, 'cache-performance-coverage.json'), JSON.stringify({
        builtInBash: true, installedAFTExecuted: false, calls: 11, results: 11, modelContexts: 12,
        bashCalls: 8, fullOutputLinesPerBash: 1000, customComponents: 10, hiddenNativeComponents: 1,
        replayCalls: 0, replayResults: 0, replayModelContexts: 0, snapshots,
        checked: ['exact independent body oracle', 'physical panel/theme/output cells', 'native wheel/editor/no-hover frames',
          'single native result replacement/reused-object/restore', 'one latest width', 'theme rebuild counts', 'one native bash click expansion/collapse',
          'immediate tiny-budget eviction', 'zero retention/skips', 'clear cold rebuild', 'off release/on cold', 'native/replay/session/model identity'],
      }, null, 2));
    } finally { for (const terminal of terminals.reverse()) { await terminal.close(); terminal.dispose(); } }
  });
