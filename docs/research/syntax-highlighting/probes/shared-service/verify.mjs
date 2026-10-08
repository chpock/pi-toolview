// Verify the saved final packet without repeating costly measurements.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strip } from './rpc.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(resolve(dir, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length, 33);
const groups = new Map(), hashes = new Map();
let clients = 0, calls = 0;
for (const r of rows) {
  assert.equal(r.harnessVersion, 2);
  assert.equal(r.node, 'v22.19.0');
  assert.ok([1, 10].includes(r.count));
  const key = `${r.kind}/${r.count}`;
  const trials = groups.get(key) ?? new Set();
  assert.ok(!trials.has(r.trial));
  trials.add(r.trial); groups.set(key, trials);
  clients += r.count;
  for (const phase of ['baseline', 'init', 'bench', 'stream', 'stress', 'release']) {
    assert.equal(r.phases[phase].individualClients.length, r.count);
    for (const metric of ['rss', 'pss', 'private', 'swapPss']) {
      assert.equal(r.phases[phase].total[metric], r.phases[phase].clients[metric] + r.phases[phase].servers[metric]);
      assert.ok(Number.isFinite(r.phases[phase].total[metric]));
    }
  }
  for (const [i, c] of r.clientPhases.bench.entries()) {
    assert.equal(c.rows.length, 9);
    for (const test of c.rows) {
      assert.equal(test.timesMs.length, 4);
      assert.equal(test.computeMs.length, 4);
      assert.ok(test.timesMs.every(n => Number.isFinite(n) && n > 0));
      const input = `${i}/${test.name}`;
      if (hashes.has(input)) assert.equal(test.sourceHash, hashes.get(input));
      else hashes.set(input, test.sourceHash);
    }
  }
  for (const c of r.clientPhases.stream) {
    assert.equal(c.rows.length, 2);
    for (const test of c.rows) assert.equal(test.updates, 32);
  }
  for (const c of r.clientPhases.release) {
    assert.equal(c.calls, 117); calls += c.calls;
    assert.equal(c.heap.retainedAnsiBytes, 0);
  }
  if (r.kind === 'inprocess') assert.equal(r.statistics.length, 0);
  else {
    assert.equal(r.statistics.reduce((n, s) => n + s.highlights, 0), 117 * r.count);
    assert.ok(r.statistics.every(s => s.cacheHits === 0));
  }
}
assert.equal(groups.size, 11);
for (const trials of groups.values()) assert.deepEqual([...trials].sort(), [0, 1, 2]);
assert.equal(clients, 195); assert.equal(calls, 22815);
for (const kind of ['tree', 'syntect', 'giallo', 'shiki']) {
  const c = JSON.parse(readFileSync(resolve(dir, `check-${kind}.json`), 'utf8'));
  for (const r of c.checks) {
    assert.ok(r.ok); assert.equal(strip(r.ansi), r.text);
    const size = r.offsetUnit === 'utf16' ? r.text.length : Buffer.byteLength(r.text);
    let end = 0;
    for (const [a, b] of r.spans) { assert.equal(a, end); assert.ok(b > a && b <= size); end = b; }
    assert.equal(end, size);
  }
  for (const r of c.special) {
    if (kind === 'giallo' && r.text.includes('\r')) {
      assert.equal(r.ok, false); assert.equal(r.error, 'giallo_normalized_line_endings');
    } else { assert.ok(r.ok); assert.equal(strip(r.ansi), r.text); }
  }
  assert.equal(c.after.highlights - c.before.highlights, 1);
  assert.equal(c.after.cacheHits - c.before.cacheHits, 9);
  assert.equal(c.afterDuplicates.highlights - c.after.highlights, 0);
  assert.equal(c.afterDuplicates.cacheHits - c.after.cacheHits, 20);
  assert.equal(c.duplicateComputeNs.length, 20);
  assert.ok(c.duplicateComputeNs.every(n => n === 0));
}
console.log(`Verified: ${rows.length} v2 scenarios, ${clients} fresh clients, ${calls} full-highlight calls, all hashes/footprints/counters; four exact-source/cache packets, expected Giallo CRLF rejection.`);
