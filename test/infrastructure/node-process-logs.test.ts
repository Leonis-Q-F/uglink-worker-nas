import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { NodeProcessLogStore, captureProcessOutput } from '../../src/infrastructure/logging/node-process-logs';
import { createContainerLogStream } from '../../src/infrastructure/logging/container-log-stream';
import type { RuntimeLogEntry } from '../../src/domain/logging/model';

function directory(t: test.TestContext) {
  const result = mkdtempSync(join(tmpdir(), 'uglink-process-logs-'));
  t.after(() => rmSync(result, { recursive: true, force: true }));
  return result;
}
function history(source: NodeProcessLogStore) {
  const subscription = source.subscribe(() => {});
  subscription.unsubscribe();
  return subscription.history;
}
function output(highWaterMark = 16_384) {
  const chunks: Buffer[] = [];
  const stream = new Writable({ highWaterMark, write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

test('captures real stdout/stderr writes and warnings while teeing original bytes and complete UTF-8 lines', async (t) => {
  const source = new NodeProcessLogStore(directory(t));
  const stdout = output();
  const stderr = output();
  const capture = captureProcessOutput(source, stdout.stream, stderr.stream);
  t.after(() => capture.dispose());
  const unicode = Buffer.from('控制台 ready\r\nnext');
  stdout.stream.write(unicode.subarray(0, 2));
  assert.equal(history(source).length, 0);
  stdout.stream.write(unicode.subarray(2));
  stderr.stream.write('(node:42) ExperimentalWarning: SQLite is an experimental feature\n');
  stdout.stream.write(' line\n');
  stderr.stream.write('TypeError: native failure\n    at main (entry.mjs:42:5)\n');
  assert.equal(stdout.text(), '控制台 ready\r\nnext line\n');
  assert.equal(stderr.text(), '(node:42) ExperimentalWarning: SQLite is an experimental feature\nTypeError: native failure\n    at main (entry.mjs:42:5)\n');
  const entries = history(source);
  assert.deepEqual(entries.map((entry) => [entry.stream, entry.message, entry.level]), [
    ['stdout', '控制台 ready', 'info'], ['stderr', '(node:42) ExperimentalWarning: SQLite is an experimental feature', 'info'],
    ['stdout', 'next line', 'info'], ['stderr', 'TypeError: native failure', 'info'], ['stderr', '    at main (entry.mjs:42:5)', 'info']
  ]);
  assert.ok(entries.every((entry) => entry.source === 'container'));
});

test('preserves write callback arguments, receiver, encodings and backpressure results', async (t) => {
  const source = new NodeProcessLogStore(directory(t));
  let finishWrite: ((error?: Error | null) => void) | undefined;
  const stdout = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { finishWrite = callback; } });
  const stderr = output().stream;
  const original = stdout.write;
  const capture = captureProcessOutput(source, stdout, stderr);
  const callback = new Promise<void>((resolve, reject) => {
    const result = stdout.write('68656c6c6f0a', 'hex', (error) => error ? reject(error) : resolve());
    assert.equal(result, false);
  });
  assert.equal(history(source)[0]?.message, 'hello');
  finishWrite!();
  await callback;
  capture.dispose();
  assert.equal(stdout.write, original);
});

test('flushes partial lines on shutdown and omits oversized logical lines without leaking a split secret', (t) => {
  const source = new NodeProcessLogStore(directory(t));
  source.registerSecrets(['secret-crossing-chunk']);
  const stdout = output();
  const capture = captureProcessOutput(source, stdout.stream, output().stream, { maxLineBytes: 64 });
  stdout.stream.write('plain partial');
  capture.flush();
  stdout.stream.write('x'.repeat(60) + 'secret-');
  stdout.stream.write('crossing-chunk\nhealthy\n');
  capture.dispose();
  const entries = history(source);
  assert.equal(entries[0]?.message, 'plain partial');
  assert.match(entries[1]?.message ?? '', /omitted/u);
  assert.equal(entries[2]?.message, 'healthy');
  assert.equal(JSON.stringify(entries).includes('secret-'), false);
});

test('redacts generic credentials and registered exact tokens before durable storage and live delivery', (t) => {
  const path = directory(t);
  const source = new NodeProcessLogStore(path);
  source.registerSecrets(['opaque-session-value']);
  const live: RuntimeLogEntry[] = [];
  const subscription = source.subscribe((entry) => live.push(entry));
  source.append('stderr', 'failure opaque-session-value password=nas-private Bearer bearer-private');
  subscription.unsubscribe();
  for (const value of [readFileSync(join(path, 'console.jsonl'), 'utf8'), JSON.stringify(live)]) {
    assert.match(value, /failure/u);
    for (const secret of ['opaque-session-value', 'nas-private', 'bearer-private']) assert.equal(value.includes(secret), false, secret);
  }
});

test('replays stable IDs from a previous boot, tolerates a crash-truncated tail, and redacts newly registered session secrets', (t) => {
  const path = directory(t);
  const previous = new NodeProcessLogStore(path);
  previous.append('stdout', 'previous boot startup');
  previous.append('stderr', 'native failure opaque-session-value');
  const ids = history(previous).map((entry) => entry.id);
  const file = join(path, 'console.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8') + '{"broken":');
  const current = new NodeProcessLogStore(path);
  current.registerSecrets(['opaque-session-value']);
  current.append('stdout', 'new boot ready');
  const entries = history(current);
  assert.deepEqual(entries.slice(0, 2).map((entry) => entry.id), ids);
  assert.equal(entries[2]?.message, 'new boot ready');
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 3);
  assert.equal(readFileSync(file, 'utf8').includes('opaque-session-value'), false);
  assert.equal(JSON.stringify(entries).includes('opaque-session-value'), false);
});

test('bounds displayed rows and both rotated files while retaining newest rows across restart', (t) => {
  const path = directory(t);
  const options = { maxEntries: 3, maxFileBytes: 2_048 };
  const source = new NodeProcessLogStore(path, options);
  for (let index = 0; index < 40; index++) source.append('stdout', `${index} ${'x'.repeat(300)}`);
  assert.deepEqual(history(source).map((entry) => entry.message.split(' ')[0]), ['37', '38', '39']);
  assert.equal(readdirSync(path).filter((file) => file.endsWith('.jsonl')).length, 2);
  for (const file of readdirSync(path)) assert.ok(statSync(join(path, file)).size <= 2_048, file);
  const restarted = new NodeProcessLogStore(path, options);
  assert.deepEqual(history(restarted).map((entry) => entry.message.split(' ')[0]), ['37', '38', '39']);
});

test('storage failures leave original stdout writes and in-memory streaming operational', (t) => {
  const path = join(directory(t), 'not-directory');
  writeFileSync(path, 'file blocks log directory');
  const source = new NodeProcessLogStore(path);
  const stdout = output();
  const capture = captureProcessOutput(source, stdout.stream, output().stream);
  stdout.stream.write('still running\n');
  capture.dispose();
  assert.equal(stdout.text(), 'still running\n');
  assert.equal(history(source)[0]?.message, 'still running');
});

test('replays and streams each row once with stable SSE IDs and releases subscriptions on disconnect', async (t) => {
  const source = new NodeProcessLogStore(directory(t));
  source.append('stdout', 'saved startup');
  const abort = new AbortController();
  const response = createContainerLogStream({ source, signal: abort.signal, heartbeatMs: 60_000 });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"state":"connected"/u);
  source.append('stderr', 'live warning');
  const saved = new TextDecoder().decode((await reader.read()).value);
  const live = new TextDecoder().decode((await reader.read()).value);
  assert.match(saved, /saved startup/u);
  assert.match(live, /live warning/u);
  assert.match(saved, /^id: [\w-]+\nevent: log\ndata:/u);
  await reader.cancel();
  source.append('stdout', 'after disconnect');
  assert.equal((await reader.read()).done, true);
  // All 32 subscription slots must still be available after cancel.
  const active = Array.from({ length: 32 }, () => source.subscribe(() => {}));
  assert.throws(() => source.subscribe(() => {}), /数量/u);
  for (const subscription of active) subscription.unsubscribe();
  source.closeStreams();
});

test('captures the actual child process stdout and next-tick native warning without altering exit or raw output', (t) => {
  const path = directory(t);
  const moduleUrl = pathToFileURL(resolve('src/infrastructure/logging/node-process-logs.ts')).href;
  const script = `import { NodeProcessLogStore, captureProcessOutput } from ${JSON.stringify(moduleUrl)};
const source = new NodeProcessLogStore(${JSON.stringify(path)});
const capture = captureProcessOutput(source);
process.on('exit', () => capture.dispose());
process.stdout.write('startup par');
process.stdout.write('tial\\n');
process.emitWarning('native SQLite warning', { type: 'ExperimentalWarning' });
process.stderr.write('raw stderr error\\n');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'startup partial\n');
  assert.match(result.stderr, /raw stderr error/u);
  assert.match(result.stderr, /ExperimentalWarning: native SQLite warning/u);
  const entries = history(new NodeProcessLogStore(path));
  assert.ok(entries.some((entry) => entry.stream === 'stdout' && entry.message === 'startup partial'));
  assert.ok(entries.some((entry) => entry.stream === 'stderr' && entry.message.includes('ExperimentalWarning: native SQLite warning')));
  assert.ok(entries.some((entry) => entry.stream === 'stderr' && entry.message === 'raw stderr error'));
});

test('resumes after a retained SSE ID and closes live readers when the process starts shutting down', async (t) => {
  const source = new NodeProcessLogStore(directory(t));
  source.append('stdout', 'old row');
  const afterId = history(source)[0]!.id;
  source.append('stdout', 'new row');
  const response = createContainerLogStream({ source, signal: new AbortController().signal, afterId, heartbeatMs: 60_000 });
  const reader = response.body!.getReader();
  await reader.read();
  const row = new TextDecoder().decode((await reader.read()).value);
  assert.match(row, /new row/u);
  assert.doesNotMatch(row, /old row/u);
  source.closeStreams();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"state":"closed"/u);
  assert.equal((await reader.read()).done, true);
});

test('streams all 1000 large retained rows with pull backpressure before continuing live', async (t) => {
  const blocked = join(directory(t), 'file');
  writeFileSync(blocked, 'force memory-only storage for this replay stress case');
  const source = new NodeProcessLogStore(blocked);
  const message = `${'控制台\\\t'.repeat(3_000)} end`;
  for (let index = 0; index < 1_000; index++) source.append('stdout', `${index} ${message}`);
  const response = createContainerLogStream({ source, signal: new AbortController().signal, heartbeatMs: 60_000 });
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"state":"connected"/u);
  source.append('stderr', 'live after history');
  for (let index = 0; index < 1_000; index++) {
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, new RegExp(`"message":"${index} `, 'u'));
    assert.ok(Buffer.byteLength(frame) < 131_072);
  }
  assert.match(new TextDecoder().decode((await reader.read()).value), /live after history/u);
  await reader.cancel();
});
