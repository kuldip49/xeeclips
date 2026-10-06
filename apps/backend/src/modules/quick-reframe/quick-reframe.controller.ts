import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QuickReframeService } from './quick-reframe.service';
@Controller('quick-reframe')
export class QuickReframeController {
  constructor(private readonly service:QuickReframeService){}
  @Post() create(){return this.service.create();}
  @Get('history') history(){return this.service.history();}
  @Get(':id') get(@Param('id') id:string){return this.service.get(id);}
  @Delete(':id') remove(@Param('id') id:string){return this.service.remove(id);}
  @Post(':id/upload') upload(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.startUpload(id,body);}
  @Put('uploads/:uploadId/chunks/:index') chunk(@Param('uploadId') id:string,@Param('index') index:string,@Req() request:Request){return this.service.uploads.writeChunk(id,index,request);}
  @Post('uploads/:uploadId/complete') complete(@Param('uploadId') id:string){return this.service.uploads.complete(id);}
  @Delete('uploads/:uploadId') cancelUpload(@Param('uploadId') id:string){return this.service.uploads.cancel(id).then(()=>({canceled:true}));}
  @Post(':id/import') import(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.start(id,'IMPORT',body);}
  @Post(':id/analyze') analyze(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.start(id,'ANALYZE',body);}
  @Post(':id/auto-clean') clean(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.autoClean(id,body);}
  @Put(':id/plan') save(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.save(id,body);}
  @Post(':id/preview') preview(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.start(id,'PREVIEW',body);}
  @Post(':id/export') export(@Param('id') id:string,@Body() body:Record<string,unknown>){return this.service.start(id,'EXPORT',body);}
  @Post(':id/undo') undo(@Param('id') id:string){return this.service.undo(id);}
  @Post(':id/redo') redo(@Param('id') id:string){return this.service.undo(id,true);}
  @Post(':id/cancel') cancel(@Param('id') id:string){return this.service.cancel(id);}
}
