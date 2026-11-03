import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ImportError } from './source-import-errors';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
export const publicImportAddress = (address: string) => isIP(address) === 4 && !blocked.check(address, 'ipv4');
const denied = () => new ImportError('SOURCE_ADDRESS_BLOCKED', 'This source address cannot be imported.');

/** Resolve every connection, reject any mixed/private answer, then connect to the checked IP. */
export async function importAddress(host: string, resolve = lookup) {
  if (!host || host.length > 253 || /(?:^|\.)(?:localhost|local|internal|xeeclip\.me)$/iu.test(host) || host.endsWith('.')) throw denied();
  const addresses = await resolve(host, { family: 4, all: true });
  if (!addresses.length || addresses.some(a => !publicImportAddress(a.address))) throw denied();
  return addresses[0].address;
}

/** Private per-process HTTPS egress. Redirects must make another checked CONNECT.
 * Native yt-dlp downloads use this proxy; neither extractor requests nor media
 * requests can resolve a second address after the validated IP is pinned.
 */
export async function publicImportProxy(parent: AbortSignal) {
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  const credential = randomBytes(32).toString('hex');
  const authorization = Buffer.from('Basic ' + Buffer.from('import:' + credential).toString('base64'));
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(300000, () => socket.destroy());
    return socket;
  };
  const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
  server.maxConnections = 48;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (req, client, head) => {
    void (async () => {
      const supplied = Buffer.from(String(req.headers['proxy-authorization'] || ''));
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return;
      }
      // Refuse non-TLS, ambiguous authorities, IPv6 literals and nonstandard ports.
      if (!/^[a-zA-Z0-9.-]+:443$/u.test(req.url || '')) throw denied();
      const host = req.url!.slice(0, -4).toLowerCase();
      const address = await importAddress(host);
      if (signal.aborted || client.destroyed) return;
      const remote = track(connect({ host: address, port: 443 }));
      const connectionDeadline = setTimeout(() => remote.destroy(), 30000);
      remote.once('connect', () => {
        clearTimeout(connectionDeadline);
        if (signal.aborted || client.destroyed) { remote.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        client.pipe(remote); remote.pipe(client);
      });
      remote.once('close', () => { clearTimeout(connectionDeadline); client.destroy(); });
      client.once('close', () => remote.destroy());
    })().catch(error => {
      client.destroy();
      if (error instanceof ImportError && !controller.signal.aborted) controller.abort(error);
    });
  });
  const stop = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw parent.reason || denied();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    if (signal.aborted) { stop(); throw signal.reason; }
    const address = server.address();
    if (!address || typeof address === 'string') throw denied();
    return {
      url: `http://import:${credential}@127.0.0.1:${address.port}`,
      signal,
      close: async () => { signal.removeEventListener('abort', stop); stop(); },
    };
  } catch (error) { signal.removeEventListener('abort', stop); stop(); throw error; }
}
