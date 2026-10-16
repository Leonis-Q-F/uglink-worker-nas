import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';
import type { ContainerLogSource } from '../../application/console/ports';
import type { RuntimeLogEntry } from '../../domain/logging/model';
import { sanitizeLogValue } from '../security/log-redaction';

type OutputStream = 'stdout' | 'stderr';
interface StoreOptions { maxEntries?: number; maxFileBytes?: number }
interface Subscriber { entry: (entry: RuntimeLogEntry) => void; close?: () => void }
const MAX_LINE_BYTES = 131_072;

/** Synchronous bounded append keeps low-volume startup/crash output durable before exit. */
export class NodeProcessLogStore implements ContainerLogSource {
  private readonly files: readonly [string, string];
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly boot = randomUUID();
  private readonly secrets = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();
  private rows: RuntimeLogEntry[] = [];
  private sequence = 0;
  private fileBytes = 0;
  private diskAvailable = true;
  private stopping = false;

  constructor(directory: string, options: StoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(1_000, options.maxEntries ?? 1_000));
    this.maxFileBytes = Math.max(512, Math.min(2_097_152, options.maxFileBytes ?? 2_097_152));
    this.files = [join(directory, 'console.jsonl'), join(directory, 'console.1.jsonl')];
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const file of [this.files[1], this.files[0]]) {
        if (!existsSync(file)) continue;
        const rows = this.readRows(file);
        // Remove incomplete crash tails before the next append and enforce file bounds.
        this.rewrite(file, rows);
        this.rows.push(...rows);
      }
      this.rows = this.rows.slice(-this.maxEntries);
      this.fileBytes = existsSync(this.files[0]) ? statSync(this.files[0]).size : 0;
    } catch { this.diskAvailable = false; }
  }

  get persistent(): boolean { return this.diskAvailable; }

  registerSecrets(values: readonly string[]): void {
    let changed = false;
    for (const value of values) {
      if (value && value.length <= 4_096 && !this.secrets.has(value)) { this.secrets.add(value); changed = true; }
    }
    if (!changed) return;
    this.rows = this.rows.map((row) => this.safeRow(row));
    // A session restored after restart may identify a previously unknown literal.
    if (this.diskAvailable) {
      try {
        for (const file of this.files) if (existsSync(file)) this.rewrite(file, this.readRows(file));
        this.fileBytes = existsSync(this.files[0]) ? statSync(this.files[0]).size : 0;
      } catch { this.diskAvailable = false; }
    }
  }

  append(stream: OutputStream, message: string): void {
    try {
      const row = this.safeRow({ id: `${this.boot}-${++this.sequence}`, timestamp: Date.now(), source: 'container', stream,
        level: 'info', message });
      let line = `${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        row.message = '[Log entry exceeded storage limit; text omitted]';
        line = `${JSON.stringify(row)}\n`;
      }
      this.rows.push(row);
      if (this.rows.length > this.maxEntries) this.rows.splice(0, this.rows.length - this.maxEntries);
      if (this.diskAvailable) {
        try {
          const size = Buffer.byteLength(line);
          if (this.fileBytes + size > this.maxFileBytes) {
            rmSync(this.files[1], { force: true });
            if (existsSync(this.files[0])) renameSync(this.files[0], this.files[1]);
            this.fileBytes = 0;
          }
          appendFileSync(this.files[0], line, { mode: 0o600, flush: true });
          this.fileBytes += size;
        } catch { this.diskAvailable = false; }
      }
      for (const subscriber of [...this.subscribers]) {
        try { subscriber.entry(row); } catch { this.subscribers.delete(subscriber); }
      }
    } catch { /* Diagnostics must never break the original process output. */ }
  }

  subscribe(entry: Subscriber['entry'], close?: () => void, afterId?: string) {
    if (this.stopping) throw new Error('控制台正在关闭。');
    if (this.subscribers.size >= 32) throw new Error('容器日志连接数量已达到限制。');
    const subscriber: Subscriber = { entry, close };
    // Snapshot and registration are one synchronous operation: no replay/live gap.
    const index = afterId ? this.rows.findIndex((row) => row.id === afterId) : -1;
    const history = this.rows.slice(index + 1);
    this.subscribers.add(subscriber);
    return { history, unsubscribe: () => { this.subscribers.delete(subscriber); } };
  }

  closeStreams(): void {
    this.stopping = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) { try { subscriber.close?.(); } catch { /* Disconnected viewer. */ } }
  }

  private safeRow(row: RuntimeLogEntry): RuntimeLogEntry {
    return { ...row, message: sanitizeLogValue(row.message, [...this.secrets]) as string };
  }

  private readRows(file: string): RuntimeLogEntry[] {
    const size = statSync(file).size;
    const length = Math.min(size, this.maxFileBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(file, 'r');
    let read = 0;
    try {
      while (read < length) {
        const amount = readSync(descriptor, buffer, read, length - read, size - length + read);
        if (!amount) break;
        read += amount;
      }
    } finally { closeSync(descriptor); }
    let text = buffer.subarray(0, read).toString('utf8');
    if (size > length) text = text.slice(text.indexOf('\n') + 1);
    const rows: RuntimeLogEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as RuntimeLogEntry;
        if (value.source !== 'container' || !/^[\w-]{1,120}$/u.test(value.id) || !Number.isFinite(value.timestamp)
          || (value.stream !== 'stdout' && value.stream !== 'stderr') || typeof value.message !== 'string'
          || !['debug', 'info', 'warning', 'error'].includes(value.level)) continue;
        rows.push(this.safeRow({ id: value.id, source: 'container', stream: value.stream,
          timestamp: value.timestamp, message: value.message, level: value.level }));
      } catch { /* An interrupted append may leave one incomplete JSON line. */ }
    }
    return rows;
  }

  private rewrite(file: string, rows: readonly RuntimeLogEntry[]): void {
    const lines: string[] = [];
    let bytes = 0;
    for (let index = rows.length - 1; index >= 0; index--) {
      const line = `${JSON.stringify(rows[index])}\n`;
      const length = Buffer.byteLength(line);
      if (bytes + length > this.maxFileBytes) break;
      lines.push(line);
      bytes += length;
    }
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(temporary, lines.reverse().join(''), { mode: 0o600, flush: true });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    } finally { rmSync(temporary, { force: true }); }
  }
}

/** Tee writes without changing arguments, callbacks, return values or the original byte stream. */
export function captureProcessOutput(source: NodeProcessLogStore, stdout: Writable = process.stdout, stderr: Writable = process.stderr,
  options: { maxLineBytes?: number } = {}) {
  const maxLineBytes = Math.max(64, Math.min(MAX_LINE_BYTES, options.maxLineBytes ?? MAX_LINE_BYTES));
  const restorers: (() => void)[] = [];
  const flushers: (() => void)[] = [];
  let recording = false;
  let disposed = false;
  for (const [name, output] of [['stdout', stdout], ['stderr', stderr]] as const) {
    const original = output.write;
    let decoder = new StringDecoder('utf8');
    let partial = '';
    let partialBytes = 0;
    let omitted = false;
    function publish() {
      source.append(name, omitted ? '[Log line exceeded capture limit; text omitted]' : partial.replace(/\r$/u, ''));
      partial = ''; partialBytes = 0; omitted = false;
    }
    function receive(text: string) {
      const parts = text.split('\n');
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        if (!omitted) {
          partialBytes += Buffer.byteLength(part);
          if (partialBytes > maxLineBytes) { omitted = true; partial = ''; }
          else partial += part;
        }
        if (index < parts.length - 1) publish();
      }
    }
    const wrapped: Writable['write'] = function (this: Writable, chunk: unknown,
      encoding?: BufferEncoding | ((error?: Error | null) => void), _callback?: (error?: Error | null) => void) {
      const args = Array.from(arguments) as unknown[];
      const result = Reflect.apply(original, this, args) as boolean;
      if (!recording && !disposed) {
        recording = true;
        try {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk as Uint8Array;
          receive(decoder.write(Buffer.from(bytes)));
        } catch { /* Capture cannot change normal stream writes. */ }
        finally { recording = false; }
      }
      return result;
    };
    output.write = wrapped;
    restorers.push(() => { if (output.write === wrapped) output.write = original; });
    flushers.push(() => {
      receive(decoder.end()); decoder = new StringDecoder('utf8');
      if (partial || omitted) publish();
    });
  }
  function flush() {
    if (disposed || recording) return;
    recording = true;
    try { for (const flush of flushers) { try { flush(); } catch { /* Best-effort crash flush. */ } } }
    finally { recording = false; }
  }
  return { flush, dispose() { if (disposed) return; flush(); disposed = true; for (const restore of restorers) restore(); } };
}
