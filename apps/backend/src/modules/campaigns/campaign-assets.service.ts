import { BadRequestException, ForbiddenException, Injectable, NotFoundException, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rm, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { requestIdentity } from '../auth/request-context';
import {campaignPage,campaignText} from './campaign-contract';
const exec = promisify(execFile);
export function campaignOwner() { const id = requestIdentity.getStore()?.userId; if (!id)
    throw new ForbiddenException(); return id; }
export function safeRelativePath(value: unknown) { if (value == null || value === '')
    return ''; if (typeof value !== 'string' || value.length > 500 || /^[\\/]|^[a-z]:|[\x00-\x1f]/i.test(value) || value.replaceAll('\\', '/').split('/').some(v => v === '..' || v === '.' || !v))
    throw new BadRequestException('Invalid relative folder path.'); return value.replaceAll('\\', '/'); }
const types: Record<string, {
    mime: string[];
    kind: string;
}> = { '.png': { mime: ['image/png'], kind: 'IMAGE' }, '.jpg': { mime: ['image/jpeg'], kind: 'IMAGE' }, '.jpeg': { mime: ['image/jpeg'], kind: 'IMAGE' }, '.webp': { mime: ['image/webp'], kind: 'IMAGE' }, '.mp3': { mime: ['audio/mpeg'], kind: 'MUSIC' }, '.wav': { mime: ['audio/wav', 'audio/x-wav'], kind: 'MUSIC' }, '.m4a': { mime: ['audio/mp4', 'audio/x-m4a'], kind: 'MUSIC' }, '.ogg': { mime: ['audio/ogg'], kind: 'MUSIC' }, '.flac': { mime: ['audio/flac'], kind: 'MUSIC' }, '.mp4': { mime: ['video/mp4'], kind: 'REFERENCE' }, '.webm': { mime: ['video/webm'], kind: 'REFERENCE' }, '.txt': { mime: ['text/plain'], kind: 'DOCUMENT' }, '.pdf': { mime: ['application/pdf'], kind: 'DOCUMENT' }, '.docx': { mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], kind: 'DOCUMENT' } };
export function validateAssetSignature(name: string, mime: string, head: Buffer, size: number) {
    const ext = extname(name).toLowerCase(), spec = types[ext];
    if (!spec || !spec.mime.includes(mime.toLowerCase()))
        throw new BadRequestException('Unsupported file type or extension. Use PNG, JPG, WebP, MP3, WAV, M4A, OGG, FLAC, MP4, WebM, TXT, PDF or DOCX.');
    const max = spec.kind === 'IMAGE' ? 10 * 1024 ** 2 : ext === '.txt' ? 1024 ** 2 : 50 * 1024 ** 2;
    if (size < 1 || size > max)
        throw new BadRequestException('File exceeds the upload size limit. Images: 10 MiB; text: 1 MiB; other references: 50 MiB.');
    const ascii = head.toString('latin1'), magic = ext === '.png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ['.jpg', '.jpeg'].includes(ext) ? head[0] === 255 && head[1] === 216 && head[2] === 255 : ext === '.webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP' : ext === '.wav' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE' : ['.mp4', '.m4a'].includes(ext) ? ascii.slice(4, 8) === 'ftyp' : ext === '.webm' ? head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) : ext === '.pdf' ? ascii.startsWith('%PDF-') : ext === '.docx' ? ascii.startsWith('PK\x03\x04') : ext === '.ogg' ? ascii.startsWith('OggS') : ext === '.flac' ? ascii.startsWith('fLaC') : ext === '.mp3' ? ascii.startsWith('ID3') || (head[0] === 255 && (head[1] & 224) === 224) : ext === '.txt' ? !head.includes(0) : false;
    if (!magic)
        throw new BadRequestException('File contents do not match its declared type.');
    return { ext, ...spec };
}
@Injectable()
export class CampaignAssetsService {
    constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) { }
    async campaign(id: string) { const c = await this.prisma.campaign.findFirst({ where: { id, userId: campaignOwner() } }); if (!c)
        throw new NotFoundException('Campaign not found.'); return c; }
    async invalidate(id: string) { await this.prisma.campaignBrief.updateMany({ where: { campaignId: id }, data: { confirmedByUser: false, confirmedAt: null, version: { increment: 1 } } }); }
    async upload(id: string, file: Express.Multer.File, body: Record<string, unknown>) {
        let stored: {
            bucket: string;
            objectKey: string;
        } | null = null;
        try {
            await this.campaign(id);
            if (!file?.path)
                throw new BadRequestException('Select a campaign file.');
            const handle=await open(file.path,'r');let size:number,head:Buffer;try{size=(await handle.stat()).size;head=Buffer.alloc(Math.min(64,size));await handle.read(head,0,head.length,0);}finally{await handle.close();}
            const spec=validateAssetSignature(file.originalname,file.mimetype,head!,size!);
            if(body.type!==undefined&&(!['LOGO','REFERENCE','IMAGE','MUSIC','DOCUMENT'].includes(String(body.type))||body.type==='LOGO'&&spec.kind!=='IMAGE'||!['LOGO','REFERENCE'].includes(String(body.type))&&body.type!==spec.kind))throw new BadRequestException('Asset type does not match its contents.');
            const relativePath = safeRelativePath(body.relativePath);
            let media: any = {};
            let extractedText = '';
            if (spec.kind !== 'DOCUMENT') {
                try {
                    const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file.path], { timeout: 20000, maxBuffer: 1024 * 1024 });
                    media = JSON.parse(stdout);
                }
                catch {
                    throw new BadRequestException('This media file could not be decoded.');
                }
                const stream = media.streams?.find((s: any) => s.codec_type === (spec.kind === 'MUSIC' ? 'audio' : 'video'));
                if (!stream)
                    throw new BadRequestException('The required media stream is missing.');
                if (spec.kind === 'IMAGE' && (!stream.width || !stream.height || stream.width * stream.height > 40000000))
                    throw new BadRequestException('Image dimensions exceed the limit.');
                if (spec.kind === 'MUSIC' && !(Number(media.format?.duration) > .25))
                    throw new BadRequestException('Music duration is invalid.');
            }
            else if (spec.ext === '.txt') {
                try {
                    extractedText = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file.path));
                    if (extractedText.includes('\0'))
                        throw Error();
                }
                catch {
                    throw new BadRequestException('Text must be valid UTF-8 without binary content.');
                }
                if (extractedText.length > 50000)
                    throw new BadRequestException('Text files may contain up to 50,000 characters.');
            }
            const type = body.type === 'LOGO' && spec.kind === 'IMAGE' ? 'LOGO' : spec.kind;
            stored = await this.storage.uploadFile({ filePath: file.path, objectKey: `campaigns/${campaignOwner()}/${id}/${randomUUID()}${spec.ext}`, mimeType: spec.mime[0] });
            const uploaded=stored;
            const row = await this.prisma.$transaction(async tx=>{const created=await tx.campaignAsset.create({data: { campaignId: id, type, fileName: this.fileName(file.originalname,spec.ext), mimeType: spec.mime[0], bucket: uploaded.bucket, storageKey: uploaded.objectKey, sizeBytes: BigInt(size!), label: campaignText(body.label,'Label',200), extractedText, metadata: { relativePath, handling: extractedText ? 'TEXT_EXTRACTED' : spec.kind === 'DOCUMENT' ? 'REFERENCE_ONLY' : 'VERIFIED_MEDIA', duration: Number(media.format?.duration) || null, width: media.streams?.[0]?.width ?? null, height: media.streams?.[0]?.height ?? null } } });
            await tx.campaignBrief.updateMany({where:{campaignId:id},data:{confirmedByUser:false,confirmedAt:null,version:{increment:1}}});return created;});
            return this.public(row);
        }
        catch (e) {
            if (stored)
                await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
            throw e;
        }
        finally {
            if (file?.path)
                await rm(file.path, { force: true });
        }
    }
    private fileName(value:string,ext:string){const name=value.replaceAll('\\','/').split('/').at(-1)!.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim();const stem=name.toLowerCase().endsWith(ext)?name.slice(0,-ext.length):name;return (stem.slice(0,190-ext.length)||'campaign-asset')+ext;}
    public(a:any){const metadata=a.metadata as any;return {id:a.id,campaignId:a.campaignId,type:a.type,fileName:a.fileName,mimeType:a.mimeType,sizeBytes:Number(a.sizeBytes),label:a.label,required:a.required,intendedUse:a.intendedUse,uploadedAt:a.uploadedAt,metadata:{relativePath:metadata?.relativePath??'',handling:metadata?.handling??'REFERENCE_ONLY',duration:metadata?.duration??null,width:metadata?.width??null,height:metadata?.height??null},fileUrl:`/campaigns/${a.campaignId}/assets/${a.id}/file`,extractedTextAvailable:!!a.extractedText};}
    async list(page={}){return(await this.prisma.campaignAsset.findMany({where:{campaign:{userId:campaignOwner()}},orderBy:[{uploadedAt:'desc'},{id:'desc'}],...campaignPage(page,100)})).map(a=>this.public(a));}
    async get(id: string, key: string) { await this.campaign(id); const a = await this.prisma.campaignAsset.findFirst({ where: { id: key, campaignId: id } }); if (!a)
        throw new NotFoundException('Campaign asset not found.'); return a; }
    async update(id:string,key:string,body:Record<string,unknown>){const a=await this.get(id,key),required=body.required===undefined?a.required:body.required,intendedUse=body.intendedUse===undefined?a.intendedUse:body.intendedUse;if(typeof required!=='boolean'||typeof intendedUse!=='string'||!['','LOGO_TOP_RIGHT','BACKGROUND_MUSIC','IMAGE_OVERLAY','REFERENCE'].includes(intendedUse))throw new BadRequestException('Invalid asset usage.');if(intendedUse==='LOGO_TOP_RIGHT'&&a.type!=='LOGO'||intendedUse==='BACKGROUND_MUSIC'&&a.type!=='MUSIC'||intendedUse==='IMAGE_OVERLAY'&&a.type!=='IMAGE')throw new BadRequestException('Asset type does not match this usage.');const label=body.label===undefined?a.label:campaignText(body.label,'Label',200);const row=await this.prisma.$transaction(async tx=>{const changed=await tx.campaignAsset.update({where:{id:a.id},data:{required,intendedUse,label}});await tx.campaignBrief.updateMany({where:{campaignId:id},data:{confirmedByUser:false,confirmedAt:null,version:{increment:1}}});return changed;});return this.public(row);}
    async remove(id:string,key:string){const a=await this.get(id,key);await this.prisma.$transaction(async tx=>{await tx.campaignAsset.delete({where:{id:a.id}});await tx.campaignBrief.updateMany({where:{campaignId:id},data:{confirmedByUser:false,confirmedAt:null,version:{increment:1}}});});await this.storage.removeObject(a.bucket,a.storageKey).catch(()=>Logger.warn('Campaign asset cleanup will require a retry.','CampaignAssets'));return{deleted:true};}
    async file(id: string, key: string, range?: string) { const a = await this.get(id, key), size = Number(a.sizeBytes); let start = 0, end = size - 1; const match = range && /^bytes=(\d*)-(\d*)$/.exec(range); if (range && !match)
        throw new HttpException({code:'CAMPAIGN_INVALID_RANGE',message:'The requested byte range is not available.',rangeSize:size},416); if (match) {
        if (!match[1] && !match[2])
            throw new HttpException({code:'CAMPAIGN_INVALID_RANGE',message:'The requested byte range is not available.',rangeSize:size},416);
        if (!match[1])
            start = Math.max(0, size - Number(match[2]));
        else {
            start = Number(match[1]);
            if (match[2])
                end = Math.min(end, Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= size)
            throw new HttpException({code:'CAMPAIGN_INVALID_RANGE',message:'The requested byte range is not available.',rangeSize:size},416);
    } return { a, size, start, end, partial: !!range, stream: range ? await this.storage.getPartialObject(a.bucket, a.storageKey, start, end - start + 1) : await this.storage.getObject(a.bucket, a.storageKey) }; }
}
