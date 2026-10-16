const REDACTED = '[REDACTED]';
const MAX_STRING = 16_384;
const MAX_DEPTH = 10;
const MAX_ITEMS = 100;
const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|authorization|cookie|credential|apikey|sessionid|connectingip|forwardedfor|remoteaddress|clientip|^ip$|^ipaddress$|^forwarded$)/iu;

/** A bounded, JSON-safe copy suitable for displaying untrusted diagnostic payloads. */
export function sanitizeLogValue(value: unknown, secrets: readonly string[] = []): unknown {
  const visited = new WeakSet<object>();
  const knownSecrets = secrets.filter(Boolean).sort((a, b) => b.length - a.length);
  let budget = 2_000;
  function text(input: string, depth: number): string {
    let result = input.slice(0, 131_072);
    for (const secret of knownSecrets) result = result.split(secret).join(REDACTED);
    const trimmed = result.trim();
    if (depth < MAX_DEPTH && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try { return JSON.stringify(copy(JSON.parse(trimmed) as unknown, depth + 1)).slice(0, MAX_STRING); } catch { /* Plain text remains useful. */ }
    }
    result = result
      .replace(/(?:https?|wss?):\/\/[^\s<>"'\\]+/giu, (raw) => {
        try {
          const url = new URL(raw);
          url.username = ''; url.password = ''; url.search = ''; url.hash = '';
          return url.toString();
        } catch { return '[Invalid URL]'; }
      })
      .replace(/\bBearer\s+[^\s,"'<>;]+/giu, `Bearer ${REDACTED}`)
      .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu, (match) => `${match.split(':', 1)[0]}: ${REDACTED}`)
      .replace(/((?:["'])?\b[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|cookie|credential|session)[\w-]*(?:["'])?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/giu,
        (_match, prefix: string, value: string) => `${prefix}${value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED}`)
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, (address) => address.split('.').every((part) => Number(part) <= 255) ? '[IP]' : address)
      .replace(/(?<![\w])(?:[a-f\d]{0,4}:){2,}[a-f\d:.%]+(?![\w])/giu, (address) => address.includes('::') || address.split(':').length === 8 ? '[IP]' : address);
    return result.length > MAX_STRING ? `${result.slice(0, MAX_STRING)}…[Truncated]` : result;
  }
  function copy(input: unknown, depth: number): unknown {
    if (--budget < 0 || depth > MAX_DEPTH) return '[Truncated]';
    if (typeof input === 'string') return text(input, depth);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'bigint') return String(input);
    if (input === undefined) return null;
    if (typeof input !== 'object') return `[${typeof input}]`;
    if (visited.has(input)) return '[Circular]';
    visited.add(input);
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : 'Invalid Date';
    if (Array.isArray(input)) return input.slice(0, MAX_ITEMS).map((item) => copy(item, depth + 1));
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = input instanceof Error
      ? [...new Set(['name', 'message', 'stack', 'cause', ...Object.keys(input)])]
      : Object.keys(input);
    for (const key of keys.slice(0, MAX_ITEMS)) {
      const safeKey = text(key, depth + 1);
      if (SENSITIVE_KEY.test(key.replace(/[-_\s]/gu, ''))) { result[safeKey] = REDACTED; continue; }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && !('value' in descriptor)) { result[safeKey] = '[Accessor]'; continue; }
      const child: unknown = descriptor?.value ?? (input instanceof Error && key === 'name' ? input.name : undefined);
      if (child !== undefined) result[safeKey] = copy(child, depth + 1);
    }
    return result;
  }
  return copy(value, 0);
}
