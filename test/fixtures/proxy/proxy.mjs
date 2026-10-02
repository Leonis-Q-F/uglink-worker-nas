import { createServer as httpsServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
const tls = { key: readFileSync('/certs/key.pem'), cert: readFileSync('/certs/cert.pem') };
for (const [port, externalHost, standard] of [[443, 'proxy.test:15443', true], [444, 'relay.test:15444', false]]) {
  httpsServer(tls, (incoming, outgoing) => {
    const headers = { ...incoming.headers };
    for (const name of Object.keys(headers)) if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
    headers.host = standard ? 'console:8787' : externalHost;
    if (standard) {
      headers['x-forwarded-host'] = externalHost;
      headers['x-forwarded-proto'] = 'https';
    }
    const upstream = request({ host: 'console', port: 8787, path: incoming.url, method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  }).listen(port, '0.0.0.0');
}
