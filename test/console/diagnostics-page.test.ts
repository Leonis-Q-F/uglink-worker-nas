import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DiagnosticsPage } from '../../src/interfaces/web/components/DiagnosticsPage';

it('starts with container process output selected and offers only relevant container filters', () => {
  const markup = renderToStaticMarkup(createElement(DiagnosticsPage, {
    entries: [], csrfToken: 'test', focusedHostname: 'app.example.com',
    loading: false, checking: false, deploying: false, canCheck: false,
    onClearFocus() {}, onCheck() {}, onRedeploy() {}
  }));
  expect(markup).toContain('<option value="container" selected="">');
  expect(markup).toContain('aria-label="日志来源"');
  expect(markup).toContain('data-source="container"');
  expect(markup).not.toContain('aria-label="日志域名"');
  expect(markup).not.toContain('aria-label="日志级别"');
  expect(markup).toContain('纯文本');
});
