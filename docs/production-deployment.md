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

The API does not have application authentication. Anyone who knows its public
hostname can use its project, media, upload, generation, and deletion routes.
This deployment intentionally has no Cloudflare Access policy. CORS restricts
browser origins, but does not restrict direct HTTP clients.

## Start the laptop services

The ignored root `.env` holds production secrets. Its `FRONTEND_ORIGIN` should
contain `https://xeeclip.me,http://localhost:3000`. Keep
`NEXT_PUBLIC_API_URL=http://localhost:4000` for local Compose development;
the Worker build uses the public API URL separately. Do not commit `.env`.

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

OpenNext packages the Next.js app for Cloudflare Workers. The production API
origin is in `apps/frontend/wrangler.jsonc`, and the public variable is also
embedded during the build. The Wrangler custom domain route attaches
`xeeclip.me` and lets Cloudflare create its DNS and TLS records. The Worker
has no `workers.dev` or preview URL.

```powershell
Set-Location C:\projects\ai-content-platform
$env:NEXT_PUBLIC_API_URL='https://api.xeeclip.me'
$env:SERVER_API_URL='https://api.xeeclip.me'
npm run build:cloudflare --workspace apps/frontend
npx wrangler deploy --config apps/frontend/wrangler.jsonc
Invoke-WebRequest https://xeeclip.me
```

Local Compose frontend development still uses `http://localhost:3000` and
calls `http://localhost:4000`. If processing later moves to a VPS, move the
same API and its Docker services there, repoint `api.xeeclip.me` to a tunnel on
that server, and keep the frontend API URL unchanged.

## Remote acceptance checks

Test from another network while the laptop and tunnel are running. Confirm
`https://xeeclip.me` loads and `https://api.xeeclip.me/health` returns 200.
Check that browser Network requests use the HTTPS API hostname. Create a test
project and exercise file upload, an eligible YouTube URL import, Automatic 1,
Automatic 2, Edit, Ask AI, Export, and reload/resume. Seek through a source
and generated video. A range request to a real video ID should return 206,
`Accept-Ranges: bytes`, and a valid `Content-Range` and video content type.
Test the offline message by stopping the backend briefly, then restore it.

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
