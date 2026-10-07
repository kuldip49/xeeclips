import { BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { lookup } from 'dns/promises';
import { request } from 'https';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type { LookupFunction } from 'net';
import type { ReframeSocialSource } from '@ai-content-platform/shared';
const exec=promisify(execFile);
export const MAX_REFRAME_BYTES=1024*1024*1024;
export function socialSource(value: unknown) {
  if(typeof value!=='string'||value.length>2048)throw new BadRequestException('Paste an Instagram or X video link.');
  let u:URL;try{u=new URL(value);}catch{throw new BadRequestException('Paste a valid HTTPS video link.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw new BadRequestException('Use a public HTTPS video link.');
  const host=u.hostname.toLowerCase();let platform:'instagram'|'x';
  if(['instagram.com','www.instagram.com'].includes(host) && /^\/(?:reel|reels|p|tv)\/[a-zA-Z0-9_-]+\/?$/u.test(u.pathname))platform='instagram';
  else if(['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host) && /^\/[a-zA-Z0-9_]{1,15}\/status\/\d+\/?(?:video\/\d+\/?)?$/u.test(u.pathname))platform='x';
  else throw new BadRequestException('Use an Instagram Reel/video or X status video link. Upload a file for other sources.');
  u.search='';return {platform,url:u.toString()};
}
function publicAddress(ip:string) {
  // Pin DNS to a public IPv4 address. IPv6, private and special-purpose ranges are refused.
  const a=ip.split('.').map(Number);if(a.length!==4||a.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  return !(a[0]===0||a[0]===10||a[0]===127||a[0]>=224||a[0]===169&&a[1]===254||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&[0,168].includes(a[1])||a[0]===100&&a[1]>=64&&a[1]<=127||a[0]===198&&[18,19,51].includes(a[1])||a[0]===203&&a[1]===0&&a[2]===113);
}
const allowedMediaHost=(host:string,platform:string)=>platform==='instagram' ? /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/u.test(host) : /(?:^|\.)twimg\.com$/u.test(host);
export function pinnedLookup(address: string): LookupFunction {
  return (_host,options,callback)=>callback(null,options.all ? [{address,family:4}] : address,4);
}
/** Whitelist public post context from the existing retriever. Missing/malformed copy never fails media import. */
export function socialPostContext(meta: unknown, source: ReturnType<typeof socialSource>): ReframeSocialSource {
  const data = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
  const clean = (value: unknown, limit: number) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim().slice(0, limit) : '';
  const text = clean(data.description, 6000);
  const tags = [...(text.match(/#[\p{L}\p{N}_]+/gu) ?? []),
    ...(Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string').map(t => `#${t.replace(/^#+/u, '')}`) : [])];
  const seen = new Set<string>();
  const hashtags = tags.filter(t => /^#[\p{L}\p{N}_]{1,60}$/u.test(t) && !seen.has(t.toLowerCase()) && !!seen.add(t.toLowerCase())).slice(0, 30);
  return { sourcePlatform: source.platform, sourcePostUrl: source.url, sourcePostText: text, sourceHashtags: hashtags,
    ...(clean(data.uploader ?? data.channel, 120) ? { sourceAuthor: clean(data.uploader ?? data.channel, 120) } : {}),
    ...(clean(data.title, 300) ? { sourcePostTitle: clean(data.title, 300) } : {}) };
}
export async function downloadSocial(value:unknown,path:string,signal:AbortSignal) {
  signal=AbortSignal.any([signal,AbortSignal.timeout(180000)]);
  const source=socialSource(value);
  if(process.env.QUICK_REFRAME_SOCIAL_IMPORT_APPROVED!=='true')throw new BadRequestException('Automatic social import is unavailable on this deployment. Upload your authorized MP4 or MOV instead.');
  const {stdout}=await exec(process.env.YOUTUBE_IMPORT_BINARY||'yt-dlp',['--ignore-config','--no-playlist','--no-warnings','--skip-download','--dump-single-json','--socket-timeout','15','-f','best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]','--',source.url],{timeout:60000,maxBuffer:5*1024*1024,signal});
  const meta=JSON.parse(stdout);
  if(meta.webpage_url && socialSource(meta.webpage_url).platform!==source.platform)throw new BadRequestException('The link redirected outside the selected platform. Upload a file instead.');
  // Some eligible Instagram metadata omits duration; actual downloaded media is always probed.
  if(Number.isFinite(meta.duration)&&(meta.duration>180||meta.duration<=0))throw new BadRequestException('Quick Reframe accepts videos up to 180 seconds.');
  const fetchStream=async(raw:string,redirects=0):Promise<import('http').IncomingMessage>=>{
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!allowedMediaHost(u.hostname,source.platform)||redirects>4)throw new BadRequestException('The media redirect is unsupported. Upload a file instead.');
    const addresses=await lookup(u.hostname,{all:true,family:4});
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new BadRequestException('The media address is unavailable. Upload a file instead.');
    const pinned=addresses[0];
    return new Promise((resolve,reject)=>{
      const req=request(u,{signal,lookup:pinnedLookup(pinned.address),headers:{'User-Agent':'XeeClip Quick Reframe'}},res=>{
        if([301,302,303,307,308].includes(res.statusCode||0)&&res.headers.location){res.resume();fetchStream(new URL(res.headers.location,u).toString(),redirects+1).then(resolve,reject);return;}
        if(res.statusCode!==200 || Number(res.headers['content-length'])>MAX_REFRAME_BYTES){res.destroy();reject(new BadRequestException('Social media is unavailable or too large. Upload your source file.'));return;}
        resolve(res);
      });req.setTimeout(15000,()=>req.destroy(new Error('Import timed out')));req.on('error',reject);req.end();
    });
  };
  const response=await fetchStream(meta.url);let bytes=0;
  const bound=new Transform({transform(chunk,_encoding,cb){bytes+=chunk.length;cb(bytes>MAX_REFRAME_BYTES?new Error('Video exceeds the file limit'):null,chunk);}});
  await pipeline(response,bound,createWriteStream(path),{signal});return socialPostContext(meta, source);
}
