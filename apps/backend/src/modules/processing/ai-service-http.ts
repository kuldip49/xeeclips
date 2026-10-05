// Long-running calls to the AI service (transcription, visual analysis).
//
// Node's global fetch (undici) enforces a hidden 300 s headers timeout that no fetch option
// can raise, and the AI service answers only when the work is done. A 60-minute source takes
// ~6 minutes to transcribe, so every long source failed with "fetch failed: HeadersTimeoutError"
// even though AI_SERVICE_TIMEOUT_MS allows 30 minutes. This helper uses node:http so the ONLY
// limit is the configured one.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type AiServiceResponse = { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };

export function postAiServiceJson(url: string, body: unknown, timeoutMs: number): Promise<AiServiceResponse> {
  const target = new URL(url);
  const payload = Buffer.from(JSON.stringify(body));
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`AI service request timed out after ${Math.round(timeoutMs / 1000)}s`),
        { name: 'TimeoutError' });
      request.destroy(error);
      fail(error);
    }, timeoutMs);
    const request = send(target, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length } },
    (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', (error) => { clearTimeout(timer); fail(error); });
      response.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text,
          json: async () => JSON.parse(text) as unknown });
      });
    });
    request.on('error', (error) => { clearTimeout(timer); fail(error); });
    request.end(payload);
  });
}

/** A dropped connection or a 5xx: the AI service crashed or restarted mid-request. */
export function isTransientAiServiceFailure(error: unknown, status?: number) {
  if (typeof status === 'number') return status >= 500;
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ||
    /socket hang up|ECONNRESET|ECONNREFUSED|other side closed/i.test(message);
}

/** Polls the AI service health endpoint until it answers OK (it restarts after a crash). */
export async function waitForAiServiceHealthy(baseUrl: string, maxWaitMs: number) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const healthy = await new Promise<boolean>((resolve) => {
      const target = new URL('/health', baseUrl);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(target, { method: 'GET', timeout: 5000 }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(false));
      request.end();
    });
    if (healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}
