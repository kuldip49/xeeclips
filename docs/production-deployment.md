# xeeclip.me deployment

## Layout

The public Next.js frontend runs as the `xeeclips-frontend` Cloudflare Worker
on `https://xeeclip.me`. Its browser and server API base URLs are both
`https://api.xeeclip.me`. A locally managed Cloudflare Tunnel named
`xeeclips-api` routes that hostname to the NestJS API at `127.0.0.1:4000` on
this Windows laptop. PostgreSQL, Redis, MinIO, the AI service, FFmpeg,
yt-dlp, and BullMQ workers stay in Docker on the laptop. Only the frontend
Worker and backend API hostname are public; Docker publishes service ports to
Windows loopback only.

The API validates database-backed secure cookie sessions and per-user ownership on all
private routes, including media. Admin operations require the sole owner role. Browser
mutations require an explicit allowed Origin. MinIO remains private and loopback-only.
See [accounts and credits](authentication-and-credits.md) for policy and recovery procedures.

## Start the laptop services

The ignored root `.env` holds production secrets. Its `FRONTEND_ORIGIN` should
contain `https://xeeclip.me,http://localhost:3000`. Keep
`NEXT_PUBLIC_API_URL=http://localhost:4000` for local Compose development;
the Worker build uses the public API URL separately. Do not commit `.env`.

Production requires `AUTH_COOKIE_SECURE=true`, `DEFAULT_USER_CREDITS=5` (configurable),
and a stable random `PASSWORD_HASH_PEPPER` of at least 32 bytes in ignored configuration,
`ADMIN_EMAIL=<confirmed-owner>`, and an initial secret `ADMIN_INITIAL_PASSWORD` for the
first startup only. `TRUST_CLOUDFLARE_IP=true` uses the tunnel's edge-provided client IP
for login limits. Use false for direct local development. Production secure cookies require
the HTTPS site/API; use AUTH_COOKIE_SECURE=false with NODE_ENV=development for a separate
local backend. Never disable secure cookies in the public production deployment.

Back up the database before deployment. The backend container runs additive migrations
before starting; do not use db push or migrate reset on production. Attribute legacy records
only after exact counts and owner confirmation, using the count-checked CLI. Restarting does
not alter existing passwords, balances or ownership.

From PowerShell after Docker Desktop starts:

```powershell
Set-Location C:\projects\ai-content-platform
$docker = 'C:\Users\kuldi\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
& $docker compose up -d --build
& $docker compose ps
Invoke-RestMethod http://localhost:4000/health
```

After reboot, sign in to Windows, start Docker Desktop, and from the project
root run `& $docker compose up -d backend` with `$docker` set as above. The
backend's dependent services start with it. The `Xeeclips Cloudflare Tunnel`
Scheduled Task starts when this user signs in and has a five-minute recovery
trigger. Verify with `Get-ScheduledTask -TaskName 'Xeeclips Cloudflare Tunnel'`;
start it manually with `Start-ScheduledTask -TaskName 'Xeeclips Cloudflare Tunnel'`
if necessary. The laptop must remain awake and online for API features.

Do not run `docker compose down -v`: this deletes persistent data. Back up
PostgreSQL and MinIO volumes and verify restores separately. Upload chunks use
the persistent `upload_staging` volume until assembly completes.

## Cloudflare DNS and tunnel

The `xeeclip.me` zone is Active in Cloudflare with nameservers
`matteo.ns.cloudflare.com` and `brenna.ns.cloudflare.com`. The tunnel ID is
`e5ba9e48-e0d8-4ae0-83bf-78daea332b81`. Its credentials, certificate,
and config are outside this repository in `C:\Users\kuldi\.cloudflared`.
The config routes only `api.xeeclip.me` to `http://127.0.0.1:4000` and returns
404 for other hostnames. Never put tunnel credentials in Git.

The DNS route is created with:

```powershell
& 'C:\Users\kuldi\.cloudflared\cloudflared.exe' tunnel route dns xeeclips-api api.xeeclip.me
```

The route creates a proxied CNAME to the tunnel. Check the ingress config,
connector, and public health endpoint with:

```powershell
& 'C:\Users\kuldi\.cloudflared\cloudflared.exe' --config 'C:\Users\kuldi\.cloudflared\config.yml' tunnel ingress validate
& 'C:\Users\kuldi\.cloudflared\cloudflared.exe' tunnel info xeeclips-api
Invoke-WebRequest https://api.xeeclip.me/health
```

## Frontend Worker

The public site is a static export of the Next.js app (`output: 'export'`, enabled only
by `npm run build:cloudflare`), served by the `xeeclips-frontend` Worker's static assets.
Cloudflare serves every file straight from its asset store without running any code, so
pages cost no Worker CPU and never wait for the laptop before sending HTML. The creation
session (`/?session=`) and the editor (`/edit-mode/<id>`) load their data in the browser.
The only Worker code, `apps/frontend/cloudflare/router.mjs`, runs first for
`/edit-mode/*` and `/projects/*` and returns the one prebuilt shell for any id (a rewrite,
so the URL stays). `public/_redirects` maps the old `/dashboard`, `/projects` and
`/edit-mode` pages. The API origin is baked in at build time from `NEXT_PUBLIC_API_URL`.
The Wrangler custom domain route attaches `xeeclip.me` and lets Cloudflare create its DNS
and TLS records. The Worker has no `workers.dev` or preview URL.

Do not move back to per-request server rendering (OpenNext) on the Workers Free plan: its
10 ms CPU limit was exceeded by ~14 ms static pages and ~660 ms editor renders, which showed
up as `Error 1102` / 503 responses and 60-150 s hangs (measured 2026-10-06).

```powershell
Set-Location C:\projects\ai-content-platform
$env:NEXT_PUBLIC_API_URL='https://api.xeeclip.me'
npm run build:cloudflare --workspace apps/frontend    # -> apps/frontend/out
npx wrangler deploy --config apps/frontend/wrangler.jsonc
Invoke-WebRequest https://xeeclip.me
```

`npm run preview:cloudflare --workspace apps/frontend` serves `out/` locally with the same
asset handling and router (`wrangler dev`).

Local Compose frontend development still uses `http://localhost:3000` and
calls `http://localhost:4000`. If processing later moves to a VPS, move the
same API and its Docker services there, repoint `api.xeeclip.me` to a tunnel on
that server, and keep the frontend API URL unchanged.

## Remote acceptance checks

Test from another network while the laptop and tunnel are running. Confirm
`https://xeeclip.me` loads and `https://api.xeeclip.me/health` returns 200.
Check that browser Network requests use the HTTPS API hostname. Open the Create
homepage and exercise file upload, an eligible YouTube URL import, StyleZero,
StyleOne, No Edit, Edit, Ask AI, Export, History persistence, and reload/resume.
The API still creates an internal Project record for each creation session; the
interface does not ask users to create or manage one. Seek through a source
and generated video. A range request to a real video ID should return 206,
`Accept-Ranges: bytes`, and a valid `Content-Range` and video content type.
Test the offline message by stopping the backend briefly, then restore it.
Deleting one History clip removes its generated file and owned edit assets,
while shared source media remains available to other clips.

On 2026-10-05, `xeeclip.me` and `api.xeeclip.me/health` both returned 200 over
HTTPS. The dashboard and local development frontend returned 200. The public
API returned the exact `xeeclip.me` CORS origin and a successful OPTIONS
preflight. A browser upload finished analysis; Automatic 1 delivered 3 of 3
requested clips. A separate browser run using a longer source delivered 2 of 2
Automatic 2 clips, then passed Edit, Ask AI, reload, and Export. Source,
generated clip, and exported video range requests returned 206. A fresh import
of the Creative Commons film *Caminandes 1: Llama Drama* reached READY,
completed analysis, and served its video with HTTP 206; the disposable import
was then removed. An earlier two-clip Automatic 2 test on a 32-second source
correctly reported only one distinct usable moment, so the longer source was
used for the complete two-clip acceptance run.

Cloudflare proxied upload limits depend on plan. The main upload form sends
files over 20 MiB in 20 MiB chunks into persistent staging; an interrupted
chunk is retried. Some reference upload paths still send one request and may
hit the proxy upload limit. A page reload during upload starts a new session.

References: [Cloudflare Tunnel DNS routes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/),
[Cloudflare Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[Cloudflare Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/),
[Cloudflare upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).
