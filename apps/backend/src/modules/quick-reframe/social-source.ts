import { BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { lookup } from 'dns/promises';
import { request } from 'https';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type { LookupFunction } from 'net';
import { resolveSourceUrl } from '../videos/source-import-policy';
import { publicImportProxy, publicImportAddress } from '../videos/source-import-proxy';
import type { ReframeSocialSource } from '@ai-content-platform/shared';
const exec=promisify(execFile);
export const MAX_REFRAME_BYTES=1024*1024*1024;
export function socialSource(value: unknown) {
  try {
    const source = resolveSourceUrl(value);
    if (source.provider !== 'INSTAGRAM' && source.provider !== 'X') throw new Error('unsupported');
    return { platform: source.provider === 'INSTAGRAM' ? 'instagram' as const : 'x' as const, url: source.sourceUrl };
  } catch { throw new BadRequestException('Use an Instagram Reel/video or X status video link. Upload a file for other sources.'); }
}

const publicAddress = publicImportAddress;
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
  const proxy=await publicImportProxy(signal);let stdout:string;
  try {
    ({stdout}=await exec(process.env.YOUTUBE_IMPORT_BINARY||'yt-dlp',['--proxy',proxy.url,'--no-plugin-dirs','--ignore-config','--no-playlist','--no-warnings','--skip-download','--dump-single-json','--socket-timeout','15','-f','best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]','--',source.url],{timeout:60000,maxBuffer:5*1024*1024,signal:proxy.signal,env:{...process.env,NO_PROXY:'',no_proxy:''}}));
  } finally { await proxy.close(); }
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
