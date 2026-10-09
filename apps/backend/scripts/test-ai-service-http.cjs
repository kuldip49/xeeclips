// Long AI-service calls (transcription / visual analysis) use node:http with ONLY the configured
// timeout. Found in the 60-minute performance run: global fetch's hidden 300 s headers timeout
// failed every source whose transcription took longer than 5 minutes. Offline.
const assert = require('node:assert/strict');
const http = require('node:http');
const { postAiServiceJson } = require('../dist/modules/processing/ai-service-http.js');

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); };

(async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.task) {
        assert.equal(parsed.task, 'transcribe', 'content paths preserve speech instead of translating it');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({text:'हमने परीक्षण किया।',language:'hi',language_probability:1,duration:2,
          segments:[{position:0,start:0,end:2,text:'हमने परीक्षण किया।',words:[]}]}));
      }
      // Headers arrive only after `delayMs` - exactly how the AI service behaves.
      setTimeout(() => {
        res.writeHead(parsed.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: parsed.object_key ?? null }));
      }, parsed.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/transcriptions`;

  const done = await postAiServiceJson(url, { object_key: 'a.wav', delayMs: 700 }, 5000);
  ok(done.ok && done.status === 200 && (await done.json()).echo === 'a.wav',
    'late headers within the configured timeout succeed (no hidden shorter limit)');
  const {VideoProcessorService}=require('../dist/modules/processing/video-processor.service');
  const processor=new VideoProcessorService({},{});processor.aiServiceUrl=url.replace('/transcriptions','');
  const native=await processor.requestTranscription('qa','native.wav');
  await processor.onModuleDestroy();
  ok(native.text==='हमने परीक्षण किया।'&&native.language==='hi','Create Clips requests native speech transcription');
  const {EditModeAnalysisService}=require('../dist/modules/edit-mode/edit-mode-analysis.service');
  const editor=new EditModeAnalysisService({async statObject(){}});editor.aiServiceUrl=processor.aiServiceUrl;
  const analyzed=await editor.analyze({bucket:'qa',objectKey:'native.mp4',metadata:{}});
  ok(analyzed.transcript.text===native.text,'generic editor preserves native language');
  const failed = await postAiServiceJson(url, { status: 503 }, 5000);
  ok(!failed.ok && failed.status === 503 && (await failed.text()).includes('echo'), 'HTTP errors keep status and body');
  const timedOut = await postAiServiceJson(url, { delayMs: 2000 }, 300).then(() => null, (error) => error);
  ok(timedOut && timedOut.name === 'TimeoutError' && /timed out after/u.test(timedOut.message),
    'the configured timeout is enforced and reported as TimeoutError');
  await new Promise((resolve) => server.close(resolve));
  const refused = await postAiServiceJson(url, {}, 2000).then(() => null, (error) => error);
  ok(refused && /ECONNREFUSED/u.test(String(refused.code ?? refused.message)), 'a down AI service is a network error');
  console.log(`AI-service HTTP tests passed (${checks} checks).`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
