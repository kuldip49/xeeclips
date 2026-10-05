/** @type {import('next').NextConfig} */
if (process.env.NODE_ENV === 'production' &&
    !/^https:\/\/[^/]+\/?$/u.test(process.env.NEXT_PUBLIC_API_URL ?? '')) {
  throw new Error('Set NEXT_PUBLIC_API_URL to the HTTPS API origin before building the frontend.');
}

const nextConfig = {
  transpilePackages: ["@ai-content-platform/shared"]
};

export default nextConfig;
