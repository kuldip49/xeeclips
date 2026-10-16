const assert = require('node:assert/strict');
const { refineReframeTranscript } = require('../dist/modules/quick-reframe/quick-reframe-transcript');
async function main(){
  const sentence='It turns out it looks more like a metal...';
  const words=sentence.split(' ').map((text,i)=>({text,start:i*.38,end:i*.38+.34,confidence:i===9?.42:.95}));
  words.at(-1).confidence=.42;
  const transcript={segments:[{start:0,end:words.at(-1).end,text:sentence,words}]};
  const calls=[];
  const request=async body=>{calls.push(body);return {window_start:0,window_end:words.at(-1).end+.1,model:body.model,
    words:words.map((word,i)=>({...word,text:i===words.length-1&&body.model==='strong'?'Manuel.':word.text,confidence:i===words.length-1?(body.model==='strong'?.96:.42):.95})),
    acoustics:{stopped:true,speech_continues:false,audio_ends_ms:1000,post_silence_ms:1000,eof:'TRAILING_SILENCE'}};};
  const refined=await refineReframeTranscript(transcript,words.at(-1).end+1,request);
  assert.deepEqual(calls.map(c=>c.model),['base','strong']);
  assert(calls.every(c=>c.window_end-c.window_start<=9));
  const last=refined.segments[0].words.at(-1);
  assert.equal(last.text,'Manuel.');assert.equal(last.asrText,'metal...');assert.equal(last.start,words.at(-1).start);
  assert.equal(last.end,words.at(-1).end);assert.equal(last.correction.kind,'ADOPT');
  await refineReframeTranscript(refined,10,request);assert.equal(calls.length,2,'saved tail evidence is reused');
  const reliable=structuredClone(transcript);reliable.segments[0].words.at(-1).confidence=.99;
  await refineReframeTranscript(reliable,10,request);assert.equal(calls.length,2,'clear speech never starts tail ASR');
  const unavailable=await refineReframeTranscript(transcript,10,async()=>{throw Error('local ASR offline');});
  assert.equal(unavailable.segments[0].words.at(-1).text,'metal...','local failure preserves source evidence');
  console.log('PASS Quick Reframe local tail ASR: bounded base/strong checks, shared consensus gate, original-word provenance, unchanged timing and persistent cache');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
