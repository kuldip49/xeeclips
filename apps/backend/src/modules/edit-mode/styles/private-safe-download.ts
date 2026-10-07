import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

/** Pin a verified public IPv4 address; refuse redirects and bound time/bytes. */
export async function downloadPublicVideo(url: URL, maxBytes: number): Promise<{ buffer: Buffer; mimeType: string }> {
  if (url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new BadRequestException('That reference address is not supported.');
  const addresses = await lookup(url.hostname, { all: true, family: 4 }).catch(() => []);
  const publicAddress = (ip: string) => {
    const [a, b] = ip.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127) && a < 224 && !(a === 198 && [18, 19].includes(b));
  };
  if (!addresses.length || addresses.some(v => !publicAddress(v.address))) throw new BadRequestException('That reference host is not allowed.');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
      family: 4,
      lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4)
    }, response => {
      if (response.statusCode !== 200 || Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy(); reject(new BadRequestException('Use a direct video link under 300 MB. Redirects are not supported.')); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) response.destroy(new Error('Reference size limit exceeded')); else chunks.push(chunk); });
      response.on('error', () => reject(new BadRequestException('The reference download could not finish.')));
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType: String(response.headers['content-type'] || 'video/mp4') }));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Reference download timed out')), 60000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => reject(new BadRequestException('The reference URL could not be downloaded.')));
  });
}
