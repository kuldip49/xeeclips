/**
 * xeeclip.me is a static export. Cloudflare serves every file in `out/` directly, without running
 * this Worker. It only runs for paths that are not files: the per-id routes, which all share one
 * prebuilt shell that reads its id from the URL. A rewrite, never a redirect, so the URL stays.
 */
const SHELLS = [
  { pattern: /^\/edit-mode\/[^/]+?(\.txt)?\/?$/u, shell: '/edit-mode/_' },
  { pattern: /^\/projects\/[^/]+?(\.txt)?\/?$/u, shell: '/projects/_' }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    for (const { pattern, shell } of SHELLS) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      // `<id>.txt` is the client router's payload request for the same page.
      const target = new URL(`${shell}${match[1] ?? ''}`, url);
      target.search = url.search;
      return env.ASSETS.fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  }
};
