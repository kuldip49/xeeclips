require('reflect-metadata');
const assert=require('assert/strict'),{randomUUID}=require('crypto');
const {Logger}=require('@nestjs/common');Logger.overrideLogger(false);
const {createHarness,seedAnalyzedProject}=require('./test-edit-mode-isolation.cjs');
const {EditorControlService}=require('../dist/modules/edit-mode/editor-control.service');
const {EditChatService}=require('../dist/modules/edit-mode/chat/edit-chat.service');
const {editorBatchSchema,EDITOR_ACTIONS}=require('../dist/modules/edit-mode/editor-command-contract');
const {PHASE3_ACTIONS}=require('../dist/modules/edit-mode/edit-command-actions');
const {planPlacement,editorLayout,roleTextStyle}=require('../dist/modules/edit-mode/editor-placement');
const {MCP_TOOLS}=require('../dist/modules/mcp/mcp-tools');
const {safeMcpError}=require('../dist/modules/mcp/mcp-operations.service');
let checks=0;const ok=(b,label)=>{assert(b,label);checks++};
const rejects=async(fn,code)=>{await assert.rejects(fn,e=>(e.getResponse?.().code||e.code)===code);checks++};
(async()=>{
 ok(PHASE3_ACTIONS.every(a=>EDITOR_ACTIONS.some(d=>d.action===a)),'all human inspector actions mapped');ok(EDITOR_ACTIONS.length===76,'71 inspector + caption creation + 4 timeline commands');
 for(const bad of [{action:'SETTINGS',payload:{}},{action:'SET_TEXT_CONTENT',elementId:randomUUID(),content:'x',properties:{x:.5}},{action:'ADD_IMAGE',assetId:randomUUID(),url:'file:///secret'},{action:'SET_VIDEO_POSITION',x:Infinity,y:0},{action:'MERGE_CAPTION',elementId:randomUUID(),direction:'LEFT'}])ok(!editorBatchSchema.safeParse([bad]).success,'strict rejected '+bad.action);
 // MERGE and zoom directions are independently canonical; unrelated direction must be refused by schema.
 const state=await seedAnalyzedProject(createHarness()),edit=state.service;
 const templates={list:async()=>({builtin:[],user:[]})},chat=new EditChatService(state.prisma,edit,null,null,templates),control=new EditorControlService(edit,chat,templates,{list:()=>[]});
 const oldVideo=[...state.rows.editElements.values()].find(e=>e.type==='VIDEO');state.rows.editElements.delete(oldVideo.id);oldVideo.id=randomUUID();state.rows.editElements.set(oldVideo.id,oldVideo);
 const id=state.project.id;let p=await edit.get(id);
 const current=()=>edit.get(id),run=async(commands)=>{p=await current();const result=await control.apply(id,p.revision,commands);p=await current();assert.equal(result.revision,p.revision);return p;};
 await run([{action:'ADD_TEXT',role:'HOOK',content:'Start here',placement:{region:'HOOK'}}]);let hook=p.elements.find(e=>e.type==='TEXT');ok(hook.properties.presetRole==='HOOK','role persisted');
 const original=structuredClone(hook),revision=p.revision;
 await run([{action:'SET_TEXT_CONTENT',elementId:hook.id,content:'Look here'}]);hook=p.elements.find(e=>e.id===hook.id);for(const key of ['x','y','width','height','zIndex','fontSize','fontFamily','background','presetRole'])assert.deepEqual(hook.properties[key],original.properties[key]);checks++;ok(hook.duration===original.duration,'text replacement preserves timing');
 await rejects(control.apply(id,revision,[{action:'SET_TEXT_CONTENT',elementId:hook.id,content:'Stale'}]),'STALE_REVISION');
 const before=await current();await rejects(control.apply(id,before.revision,[{action:'SET_TEXT_CONTENT',elementId:hook.id,content:'A'.repeat(2000)}]),'HOOK_DOES_NOT_FIT');assert.deepEqual((await current()).elements,before.elements);checks++;
 await rejects(control.apply(id,p.revision,[{action:'ADD_TEXT',role:'HOOK',content:'Overlap'}]),'PLACEMENT_CONFLICT');
 await run([{action:'ADD_SUBTITLE',content:'Corrected caption',startTime:0,duration:4,placement:{region:'CAPTIONS'}}]);const primary=p.elements.find(e=>e.type==='SUBTITLE');ok(primary.properties.content==='Corrected caption','missing caption creates canonical cue');
 await run([{action:'ADD_SUBTITLE',content:'Duplicate',startTime:0,duration:4,placement:{region:'CENTER'}}]);let list=await control.elements(id);ok(list.captionGroups.length===2,'distinct caption groups');ok(list.captionGroups.every(g=>g.role==='UNCLASSIFIED_CAPTIONS'),'unknown caption provenance never invents a primary or duplicate label');const group=list.captionGroups.find(g=>!g.elementIds.includes(primary.id));await control.removeCaptionGroup(id,p.revision,group.groupId);p=await current();ok(p.elements.filter(e=>e.type==='SUBTITLE').length===1,'selective group removal');ok(p.elements.some(e=>e.id===primary.id),'primary preserved');
 await run([{action:'ADD_TEXT',role:'CTA',content:'Follow for more',startTime:7,duration:3,placement:{region:'BELOW_CAPTIONS'}}]);ok(p.elements.find(e=>e.properties?.presetRole==='CTA').startTime===7,'timed CTA');
 const pages=await control.elements(id,0,1);ok(pages.elements.length===1&&pages.nextOffset===1,'all elements paginated');ok(!JSON.stringify(list).includes('objectKey'),'safe model excludes storage');
 const req=await control.requirements(id,[{type:'TEXT_PRESENT',value:'Corrected caption'},{type:'VISUAL_QUALITY'}]);ok(req.checks[0].status==='PASS'&&req.checks[1].status==='WARN'&&req.visualQuality==='NOT_EVALUATED','metadata is not visual proof');
 const video=p.elements.find(e=>e.type==='VIDEO');await run([{action:'SET_VIDEO_SCALE',elementId:video.id,scale:1.2},{action:'SET_VIDEO_POSITION',elementId:video.id,x:-.05,y:.04},{action:'SET_VIDEO_CROP',elementId:video.id,cropLeft:.02,cropRight:.03,cropTop:0,cropBottom:0}]);
 for(const style of ['STYLE_ONE','STYLE_TWO','STYLE_ZERO']){const old=p.elements.map(e=>structuredClone(e));await control.template(id,p.revision,style);p=await current();for(const e of old){const next=p.elements.find(n=>n.id===e.id);assert(next,'preserve existing ID');if(['TEXT','SUBTITLE'].includes(e.type)){assert.equal(next.properties.content,e.properties.content);assert.equal(next.startTime,e.startTime);assert.equal(next.duration,e.duration);}if(e.type==='VIDEO')for(const key of ['crop','scale','offsetX','offsetY'])assert.deepEqual(next.properties[key],e.properties[key]);}checks++;ok((await control.layout(id)).template==={STYLE_ONE:'AUTOMATIC_2',STYLE_TWO:'AUTOMATIC_3_STYLE_TWO',STYLE_ZERO:'AUTOMATIC_1'}[style],'canonical template '+style);}
 const ctaDefault=roleTextStyle(p,'CTA');ok(ctaDefault.background?.enabled!==true||ctaDefault.color!==ctaDefault.background.color,'CTA text cannot inherit an identical color plate');
 const styleTwoDefault=roleTextStyle({...p,settings:{editorTemplateState:{templateId:'AUTOMATIC_3_STYLE_TWO'}}},'CTA');ok(styleTwoDefault.background?.enabled===false,'StyleTwo CTA uses black text on its white canvas');
 const last=p.revision;await edit.undo(id,last);p=await current();await edit.redo(id,p.revision);p=await current();ok(p.revision===last+2,'shared history undo redo');
 for(const c of ['HOOK_DOES_NOT_FIT','HEADLINE_DOES_NOT_FIT','TEXT_DOES_NOT_FIT','PLACEMENT_CONFLICT','EDIT_CONSTRAINT_BLOCKED'])ok(safeMcpError({getResponse:()=>({code:c}),getStatus:()=>400}).code===c,'friendly safe '+c);
 const locked=p.elements.find(e=>e.type==='TEXT');await edit.setConstraints(id,{revision:p.revision,constraints:[{type:'PROTECT_HOOK_TEXT',lifetime:'PROJECT',target:{kind:'PROJECT'}}]});p=await current();const protectedRevision=p.revision;await rejects(control.apply(id,p.revision,[{action:'SET_VIDEO_BRIGHTNESS',brightness:.1},{action:'SET_TEXT_CONTENT',elementId:locked.id,content:'Changed'}]),'EDIT_CONSTRAINT_BLOCKED');ok((await current()).revision===protectedRevision,'protected batch never partially commits');
 for(const name of ['apply_edit_commands','change_template','remove_caption_group']){const t=MCP_TOOLS.find(t=>t.name==='xeeclip_'+name);ok(t.scopes.length===1&&t.scopes[0]==='xeeclip:clips:edit','independent edit scope');}
 console.log('PASS '+checks+' full-editor domain assertions: exhaustive catalog, placement, fit, roles/groups, preserved templates, history, atomic protected writes and scopes.');
})().catch(e=>{console.error(e);process.exitCode=1});
