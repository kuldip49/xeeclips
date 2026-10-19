require('reflect-metadata');
const assert=require('node:assert/strict');
const {StreamableFile,BadRequestException,HttpException}=require('@nestjs/common');
const {publicResponse}=require('../dist/modules/auth/public-response.interceptor');
const {PublicExceptionFilter}=require('../dist/modules/auth/public-exception.filter');
const stream=new StreamableFile(Buffer.from('real video bytes')),date=new Date();
const data={id:'public-id',playbackUrl:'/owned/media',createdAt:date,assets:[{id:'asset-id',bucket:'private',objectKey:'secret',metadata:{storageObjectKey:'secret',provider:'private',model:'private',sourceRevision:7}}],error:'FFmpeg failed with storageKey=secret',stream};
const projected=publicResponse(data);
assert.equal(projected.stream,stream);assert.equal(projected.createdAt,date);
assert.equal(projected.playbackUrl,'/owned/media');assert.equal(projected.assets[0].metadata.sourceRevision,7);
assert(!JSON.stringify(projected).includes('secret'));assert(!JSON.stringify(projected).includes('private'));
assert.equal(data.assets[0].objectKey,'secret','Internal render data must remain unchanged');
function response(error){let status,body;const res={status(n){status=n;return this;},json(b){body=b;return this;}};new PublicExceptionFilter().catch(error,{switchToHttp:()=>({getResponse:()=>res})});return{status,body};}
assert.equal(response(new BadRequestException('FFmpeg failed: s3://private/key')).body.message,'Processing could not finish. Please try again.');
assert.equal(response(new BadRequestException('Choose a valid video.')).body.message,'Choose a valid video.');
assert.deepEqual(response(new HttpException({code:'XEEPRO_BUSY',message:'provider JSON'},503)),{status:503,body:{statusCode:503,code:'XEEPRO_BUSY',message:'XeePro is busy right now. Try XeeFree or try again later.'}});
assert.equal(response(new HttpException({code:'NO_CREDITS',message:'No generations remaining.'},403)).body.code,'NO_CREDITS');
console.log('PASS HTTP privacy, unchanged internal data/streams, safe media errors and exact busy/credit contracts');
