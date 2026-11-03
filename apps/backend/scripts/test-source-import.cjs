require('reflect-metadata');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const net = require('node:net'), dns = require('node:dns/promises');
const { SourceImportAdapter, secureFormatSelector, classifyYtDlpError } = require('../dist/modules/videos/youtube-import.adapter');
const { resolveSourceUrl, sourceImportErrorCode } = require('../dist/modules/videos/source-import-policy');
const { ImportError } = require('../dist/modules/videos/source-import-errors');
const { publicImportAddress, importAddress, publicImportProxy } = require('../dist/modules/videos/source-import-proxy');
const { VideoImportService } = require('../dist/modules/videos/video-import.service');
const { safeMcpError } = require('../dist/modules/mcp/mcp-operations.service');
const { MCP_TOOLS } = require('../dist/modules/mcp/mcp-tools');
const id = 'abcdefghijk';
const sources = [
  { url: `https://youtu.be/${id}?si=tracking`, provider: 'YOUTUBE', id, extractor: 'Youtube' },
  { url: 'https://instagram.com/reel/Owned_video/?igsh=tracking', provider: 'INSTAGRAM', id: 'Owned_video', extractor: 'Instagram' },
  { url: 'https://twitter.com/owner/status/123456789/video/1?tracking=x', provider: 'X', id: '123456789', extractor: 'Twitter' },
];
const frames = [{ vcodec: 'avc1', acodec: 'mp4a', protocol: 'https' }];
async function main() {
  for (const x of sources) {
    const p = resolveSourceUrl(x.url);
    assert.equal(p.provider, x.provider); assert.equal(p.externalVideoId, x.id);
    assert(!/tracking|igsh|si=/.test(p.sourceUrl));
    let duration = 10800, availability = 'public', drm = false;
    const adapter = new SourceImportAdapter();
    adapter.run = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      id: x.provider === 'YOUTUBE' ? x.id : 'distinct-media-asset-id', display_id: x.id, extractor_key: x.extractor, duration, availability,
    }) + '\n' + JSON.stringify(drm ? [{ ...frames[0], has_drm: true }] : frames) });
    assert.equal((await adapter.metadata(p.sourceUrl, new AbortController().signal)).duration, 10800);
    duration = 10800.001;
    await assert.rejects(adapter.metadata(p.sourceUrl, new AbortController().signal), e => e.code === 'DURATION_LIMIT');
    duration = 30; availability = 'private';
    await assert.rejects(adapter.metadata(p.sourceUrl, new AbortController().signal), e => sourceImportErrorCode(e.code) === 'SOURCE_PRIVATE');
    availability = 'subscriber_only';
    await assert.rejects(adapter.metadata(p.sourceUrl, new AbortController().signal), e => sourceImportErrorCode(e.code) === 'SOURCE_LOGIN_REQUIRED');
    availability = 'public'; drm = true;
    await assert.rejects(adapter.metadata(p.sourceUrl, new AbortController().signal), e => sourceImportErrorCode(e.code) === 'SOURCE_DRM_PROTECTED');
  }
  const unknown = new SourceImportAdapter();
  unknown.run = async () => ({code:0,stderr:'',stdout:JSON.stringify({id:'media-id',display_id:'123456789',extractor_key:'Twitter',duration:30})+'\n'+JSON.stringify([{protocol:'https',ext:'mp4'},{protocol:'m3u8_native',vcodec:'none'}])});
  assert.equal((await unknown.metadata('https://x.com/owner/status/123456789/video/1',new AbortController().signal)).duration,30,
    'unknown codec names must defer to the real media probe, not falsely reject a supported provider');
  const second = resolveSourceUrl('https://x.com/owner/status/123456789/video/2');
  assert.equal(second.externalVideoId,'123456789:video:2');
  assert.equal(second.sourceUrl,'https://x.com/owner/status/123456789/video/2');
  for (const url of ['https://tiktok.com/@u/video/123', 'https://facebook.com/watch?v=123',
    'https://vimeo.com/123', 'https://twitch.tv/videos/123', 'https://example.com/video.mp4',
    'https://youtube.com.evil.test/watch?v='+id, 'https://instagram.com.evil.test/reel/x/',
    'https://x.com/intent/tweet']) {
    assert.throws(() => resolveSourceUrl(url), e => safeMcpError(e).code === 'UNSUPPORTED_SOURCE');
  }
  for (const url of ['file:///etc/passwd', 'http://x.com/a/status/123', 'https://a:b@x.com/a/status/123',
    'https://127.0.0.1:4000/x', 'https://youtube.com/watch?v='+id+'#bad']) assert.throws(() => resolveSourceUrl(url));
  for (const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','169.254.169.254','172.17.0.1','192.168.1.1',
    '100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.2','203.0.113.2','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1']) assert(!publicImportAddress(ip),ip);
  assert(publicImportAddress('8.8.8.8'));
  let calls = 0;
  assert.equal(await importAddress('public.example', async () => { calls++; return [{address:'8.8.8.8',family:4}]; }), '8.8.8.8');
  assert.equal(calls,1);
  await assert.rejects(importAddress('rebind.example',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),{code:'SOURCE_ADDRESS_BLOCKED'});
  await assert.rejects(importAddress('api.xeeclip.me'),{code:'SOURCE_ADDRESS_BLOCKED'});
  for (const sample of ['b','bv*+ba/b','bv*[vcodec^=avc1]+ba[acodec^=mp4a]']) {
    const selector=secureFormatSelector(sample); assert(selector.includes('http_dash_segments')); assert(!selector.includes('rtmp'));
  }
  assert.equal(classifyYtDlpError('ERROR: This video is DRM-protected','metadata'),'DRM_PROTECTED');
  for(const code of ['PRIVATE_VIDEO','LOGIN_REQUIRED','DRM_PROTECTED','DURATION_LIMIT','REGION_RESTRICTED','VIDEO_NOT_FOUND']) {
    const result=safeMcpError(new ImportError(code,'SECRET raw scraper JSON stack trace'));
    assert(!/SECRET|scraper|JSON|stack/.test(JSON.stringify(result))); assert(result.code.startsWith('SOURCE_'));
  }
  const tool=MCP_TOOLS.find(t=>t.name==='xeeclip_import_source');
  assert.deepEqual(tool.scopes,['xeeclip:sources:import']); assert.equal(tool.category,'GENERATION');
  assert(tool.schema.safeParse({url:sources[0].url,idempotencyKey:'import-key-001'}).success);
  assert(!tool.schema.safeParse({url:sources[0].url,idempotencyKey:'import-key-001',userId:'foreign'}).success);
  // Real listening proxy; remote connects are intercepted to inspect the pinned destination.
  const connectReal=net.connect, lookupReal=dns.lookup, connections=[];
  class Upstream extends Duplex { _read(){} _write(_c,_e,cb){cb();} setTimeout(){return this;} }
  net.connect=(options)=>{connections.push(options); const s=new Upstream();setImmediate(()=>s.emit('connect'));return s;};
  dns.lookup=async host=>[{address:host==='public.example'?'8.8.8.8':'127.0.0.1',family:4}];
  let proxy;
  try {
    proxy=await publicImportProxy(new AbortController().signal);const endpoint=new URL(proxy.url);
    const auth='Basic '+Buffer.from(decodeURIComponent(endpoint.username)+':'+decodeURIComponent(endpoint.password)).toString('base64');
    async function tunnel(host,header=auth) {
      return new Promise(resolve=>{const s=connectReal({host:'127.0.0.1',port:Number(endpoint.port)});let text='';
        s.on('connect',()=>s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${header}\r\n\r\n`));
        s.on('data',b=>{text+=b.toString();if(text.includes('\r\n\r\n')){s.destroy();resolve(text);}});s.on('close',()=>resolve(text));s.on('error',()=>resolve(text));
      });
    }
    assert((await tunnel('public.example','invalid')).includes('407'));assert.equal(connections.length,0);
    assert((await tunnel('public.example')).includes('200 Connection Established'));
    assert.deepEqual(connections,[{host:'8.8.8.8',port:443}], 'connect must receive the checked IP, never resolve the hostname again');
    // Follow-up CONNECT represents a downloader following a redirect to internal services.
    assert.equal(await tunnel('internal.example'),'');assert(proxy.signal.aborted);assert.equal(proxy.signal.reason.code,'SOURCE_ADDRESS_BLOCKED');
    assert.equal(connections.length,1,'redirect must not connect to the internal target');
  } finally { await proxy?.close(); net.connect=connectReal; dns.lookup=lookupReal; }
  const service=Object.create(VideoImportService.prototype);service.adapter=new SourceImportAdapter();
  process.env.YOUTUBE_IMPORT_APPROVED='true';process.env.QUICK_REFRAME_SOCIAL_IMPORT_APPROVED='true';
  assert.deepEqual(service.supportedSources().providers.map(p=>p.id),['YOUTUBE','INSTAGRAM','X']);
  const fs=require('node:fs'),ts=require('typescript');
  const entry=ts.createSourceFile('entry-flow.ts',fs.readFileSync(require('node:path').join(__dirname,'../../frontend/src/lib/entry-flow.ts'),'utf8'),ts.ScriptTarget.Latest,true);
  let defaults;
  function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(entry)==='DEFAULT_ENTRY_SETTINGS')defaults=Object.fromEntries(n.initializer.properties.map(p=>[p.name.getText(entry),p.initializer.text]));ts.forEachChild(n,visit);}visit(entry);
  assert.equal(service.supportedSources().generationDefaults.style,defaults.template==='AUTOMATIC_1'?'STYLE_ZERO':'unknown');
  assert.equal(service.supportedSources().generationDefaults.clipCount,Number(defaults.count));
  assert.equal(service.supportedSources().generationDefaults.mode,defaults.aiMode==='ONLINE'?'XEEPRO':'XEEFREE');
  assert(service.supportedSources().providers.every(p=>p.urlImport));
  delete process.env.QUICK_REFRAME_SOCIAL_IMPORT_APPROVED;
  assert.equal(service.supportedSources().providers.find(p=>p.id==='X').urlImport,false);
  let sourceStatus='PENDING';
  service.prisma={videoImport:{findUnique:async()=>({id:'import',status:'READY',videoId:'video',provider:'YOUTUBE'})}};
  service.videos={sourceSummary:async()=>({sourceId:'video',name:'Owned',duration:30,status:sourceStatus})};
  let summary=await service.sourceImportSummary('import');assert.equal(summary.status,'PROCESSING');assert(!summary.sourceId);
  sourceStatus='COMPLETED';summary=await service.sourceImportSummary('import');assert.equal(summary.status,'COMPLETE');assert.equal(summary.sourceId,'video');
  service.prisma.videoImport.findUnique=async()=>null;await assert.rejects(service.sourceImportSummary('foreign'),e=>e.getStatus()===404);
  console.log('PASS shared providers/unsupported inputs, all-provider 3-hour limits, private/login/DRM, safe errors, scoped tools, DNS pinning/rebinding, authenticated proxy redirect denial and analysis-ready source status.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
