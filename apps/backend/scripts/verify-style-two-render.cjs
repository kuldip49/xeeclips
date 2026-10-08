// Local-only acceptance. Uses an authorized source and real cached word timestamps.
// Optional STYLE_TWO_BASELINE_DIST redirects backend imports to a read-only HEAD snapshot.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const baseline = process.env.STYLE_TWO_BASELINE_DIST;
if (baseline) {
  const Module = require('node:module'), original = Module._resolveFilename;
  const current = path.join(root,'apps/backend/dist');
  Module._resolveFilename = function(...args) {
    const filename = original.apply(this,args);
    return typeof filename === 'string' && filename.startsWith(current) ? path.join(baseline,filename.slice(current.length)) : filename;
  };
}
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service');
const { EditChatProposalStore } = require('../dist/modules/edit-mode/chat/edit-chat-proposal-store');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver');
const { compileCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-commands');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass');
const { buildFfmpegArgs } = require('../dist/modules/edit-mode/render/edit-mode-filtergraph');
const { STYLE_TWO_ID: ID } = require('@ai-content-platform/shared/style-two.cjs');
const bin=path.join(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin');
const ffmpeg=path.join(bin,'ffmpeg.exe'), ffprobe=path.join(bin,'ffprobe.exe');
const source=process.argv[2], wordsFile=process.argv[3];
const output=path.resolve(process.argv[4] || path.join(root,'.real-qa-preview/style-two'));
const styles=baseline ? ['AUTOMATIC_1','AUTOMATIC_2'] : process.env.STYLE_TWO_ONLY ? [ID] : ['AUTOMATIC_1','AUTOMATIC_2',ID];
const hook=process.env.STYLE_TWO_TEST_HOOK || '“Being Somali-American is like bananas and rice...” - Wait for Crowder’s reaction';
async function main() {
  assert(source && wordsFile,'Usage: node verify-style-two-render.cjs SOURCE WORDS_JSON OUTPUT_DIR');
  fs.mkdirSync(output,{recursive:true});
  fs.cpSync(path.join(root,'apps/frontend/public/fonts'),path.join(output,'fonts'),{recursive:true});
  const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',source],{encoding:'utf8'}));
  const video=probe.streams.find(s=>s.codec_type==='video'), duration=Math.floor(Number(probe.format.duration) * 1000) / 1000;
  const words=JSON.parse(fs.readFileSync(wordsFile,'utf8'));
  const result=[];
  for (const templateId of styles) {
    if (process.env.STYLE_TWO_RESUME && templateId === 'AUTOMATIC_1' && fs.existsSync(path.join(output,'stylezero-video.md5'))) continue;
    const h=createHarness(); const seed=await seedAnalyzedProject(h); const id=seed.project.id;
    const asset=[...h.rows.editAssets.values()].find(a=>a.role==='SOURCE');
    Object.assign(asset,{width:video.width,height:video.height,duration,fps:30,metadata:{hasAudio:true},analysis:{frames:[],shotBoundaries:[],ocrText:[]},
      transcript:{wordTimings:true,text:words.map(w=>w.text).join(' '),segments:[{start:0,end:duration,text:words.map(w=>w.text).join(' '),words}]}});
    const v=[...h.rows.editElements.values()].find(e=>e.type==='VIDEO');
    Object.assign(v,{duration,trimStart:0,trimEnd:duration});
    let project=await h.service.get(id);
    // The derivative reference footage is already framed. SOURCE tests the same
    // whole-frame path Quick Reframe uses after its saved crop is baked once.
    const initial=[{kind:'SETTINGS',payload:{aspectRatio:'9:16',reframePolicy:'SOURCE',zoomPolicy:'OFF',gradingPolicy:'NONE',subtitlePolicy:'OFF'}},
      {kind:'ELEMENT',action:'ADD_TEXT',payload:{content:hook,textStyleId:'HEADING',presetRole:'HOOK'}},
      {kind:'ELEMENT',action:'GENERATE_CAPTIONS',payload:{captionStyleId:'CLEAN'}}];
    await h.service.applyAssistantBundle(id,project.revision,{proposalId:'source',summary:'Authorized source',userMessage:'source',actor:'SYSTEM_ACTION',commands:initial,onInvalid:'FAIL'});
    project=await h.service.get(id);
    if (templateId !== 'AUTOMATIC_1') {
      const chat=new EditChatService(h.prisma,h.service,new EditChatProposalStore(),{isAnyConfigured:()=>false},new EditTemplateService(h.prisma,h.service));
      const {context}=await chat.loadContext(id,'Style',{});
      const commands=compileCreativeStyle(resolveCreativeStyle({templateId}),context,{hookOptions:[{text:hook}],hasWordTimings:true}).commands;
      await h.service.applyAssistantBundle(id,project.revision,{proposalId:'style',summary:templateId,userMessage:templateId,actor:'TEMPLATE_ACTION',commands,onInvalid:'FAIL'});
      project=await h.service.get(id);
    }
    const built=buildRenderPlan({project,assets:project.assets,elements:project.elements,hasSourceAudio:true,fps:30});
    const ass=buildEditModeAss(built.plan.canvas,[...built.plan.textOverlays,...built.plan.subtitles]);
    const stem=templateId==='AUTOMATIC_1'?'stylezero':templateId==='AUTOMATIC_2'?'styleone':'styletwo';
    fs.writeFileSync(path.join(output,`${stem}.ass`),ass.content);
    fs.writeFileSync(path.join(output,`${stem}-project.json`),JSON.stringify(project,null,2));
    const args=buildFfmpegArgs({plan:built.plan,sourcePath:path.resolve(source),overlayPaths:{},audioPaths:{},assFileName:`${stem}.ass`,
      outputPath:path.join(output,`${stem}.mp4`),informationCrop:built.evidence.informationCrop,fitExpression:built.evidence.fitExpression,
      informationFitExpression:built.evidence.informationFitExpression,cameraFilter:built.evidence.cameraFilter,fontsDir:'fonts'});
    args.splice(0,0,'-loglevel','error');
    execFileSync(ffmpeg,args,{cwd:output,stdio:['ignore','ignore','pipe'],maxBuffer:10*1024*1024});
    const rendered=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',path.join(output,`${stem}.mp4`)],{encoding:'utf8'}));
    assert.equal(rendered.streams.find(s=>s.codec_type==='video').width,1080);
    assert.equal(rendered.streams.find(s=>s.codec_type==='video').height,1920);
    assert(rendered.streams.some(s=>s.codec_type==='audio'));
    assert(Math.abs(Number(rendered.format.duration)-duration)<.12);
    for (const t of [.2,1,5,15,29,45,57].filter(t=>t<duration)) execFileSync(ffmpeg,['-v','error','-ss',String(t),'-i',path.join(output,`${stem}.mp4`),'-frames:v','1','-y',path.join(output,`${stem}-${t}.png`)]);
    // Hash decoded frames/audio to compare original HEAD and changed implementation.
    execFileSync(ffmpeg,['-v','error','-i',path.join(output,`${stem}.mp4`),'-map','0:v','-f','framemd5','-y',path.join(output,`${stem}-video.md5`)]);
    execFileSync(ffmpeg,['-v','error','-i',path.join(output,`${stem}.mp4`),'-map','0:a','-f','framemd5','-y',path.join(output,`${stem}-audio.md5`)]);
    result.push({templateId,canvas:built.plan.canvas,duration,captionCount:built.plan.subtitles.length,overflow:ass.overflowed,
      parityNotes:ass.parityNotes,sourcePolicy:built.plan.policies.reframePolicy,zoomEvents:built.plan.zoomEvents,output:path.join(output,`${stem}.mp4`)});
    console.log(`${stem}: rendered full ${duration.toFixed(3)}s with audio; ${built.plan.subtitles.length} captions`);
  }
  fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.stack || e); if(e.stderr)console.error(String(e.stderr));process.exitCode=1;});
