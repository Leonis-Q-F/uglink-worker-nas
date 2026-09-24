import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceHealth } from '../../src/domain/deployment/model';
import { httpServiceHealthChecker } from '../../src/infrastructure/health/http-service-health-checker';

afterEach(() => vi.unstubAllGlobals());

function service(): ServiceHealth {
  return { hostname: 'app.example.com', healthy: true, detail: '', httpStatus: 200 };
}

describe('service entry network failures', () => {
  it.each([false, true])('reports DNS failures during deployment and monitoring (%s)', async (monitoring) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(
      'DNS lookup failed.; gai_strerror(status) = No address associated with hostname'
    )));
    const entry = service();
    await httpServiceHealthChecker.check([entry], monitoring);
    expect(entry).toMatchObject({
      healthy: false, code: 'service_entry_dns_error', stage: 'service_entry'
    });
    expect(entry.detail).toContain('DNS');
    expect(entry.detail).toContain('Docker');
    expect(entry.httpStatus).toBeUndefined();
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA'])('recognizes a nested %s DNS cause without exposing raw errors', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('private upstream detail'), { code })
    })));
    const entry = service();
    await httpServiceHealthChecker.check([entry], true);
    expect(entry.code).toBe('service_entry_dns_error');
    expect(entry.detail).not.toContain('private upstream detail');
  });

  it.each([false, true])('distinguishes timeouts from propagation (%s)', async (monitoring) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')));
    const entry = service();
    await httpServiceHealthChecker.check([entry], monitoring);
    expect(entry.code).toBe('service_entry_timeout');
    expect(entry.detail).toContain('超时');
  });

  it('preserves a response body timeout as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException('Timed out', 'TimeoutError')); }
    }))));
    const entry = service();
    await httpServiceHealthChecker.check([entry], true);
    expect(entry.code).toBe('service_entry_timeout');
  });

  it.each([false, true])('provides DNS guidance for opaque workerd errors without claiming a cause (%s)', async (monitoring) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('internal error')));
    const entry = service();
    await httpServiceHealthChecker.check([entry], monitoring);
    expect(entry.code).toBe(monitoring ? 'service_entry_unreachable' : 'domain_propagating');
    expect(entry.detail).toContain('DNS');
    expect(entry.detail).toContain('日志');
  });

  it('still rejects malformed health responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Not a Worker</html>')));
    const entry = service();
    await httpServiceHealthChecker.check([entry], true);
    expect(entry.code).toBe('worker_health_invalid_response');
  });

  it('recovers after DNS is repaired only when the Worker confirms the hostname', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('DNS lookup failed'))
      .mockResolvedValueOnce(Response.json({ status: 'ok', hostnameConfigured: true })));
    const entry = service();
    await httpServiceHealthChecker.check([entry], true);
    expect(entry.healthy).toBe(false);
    await httpServiceHealthChecker.check([entry], true);
    expect(entry).toMatchObject({ healthy: true, code: 'healthy', httpStatus: 200 });
  });
});
