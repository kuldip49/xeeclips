/** @type {import('next').NextConfig} */
if (process.env.NODE_ENV === 'production' &&
    !/^https:\/\/[^/]+\/?$/u.test(process.env.NEXT_PUBLIC_API_URL ?? '')) {
  throw new Error('Set NEXT_PUBLIC_API_URL to the HTTPS API origin before building the frontend.');
}

const nextConfig = {
  transpilePackages: ["@ai-content-platform/shared"],
  // The public site (xeeclip.me) is a static export served straight from Cloudflare's asset store:
  // no Next.js server runs per request, so it fits the Workers Free CPU budget and never waits on
  // the laptop API before sending HTML. Local `next dev` / Docker keep the normal server.
  ...(process.env.XEECLIP_STATIC_EXPORT === '1' ? { output: 'export' } : {})
};

export default nextConfig;
