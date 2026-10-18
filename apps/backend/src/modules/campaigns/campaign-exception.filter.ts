import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type {Response} from 'express';

@Catch()
export class CampaignExceptionFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost){
    const response=host.switchToHttp().getResponse<Response>();
    const e=error as {code?:string;name?:string};
    if(e?.code==='P2002'||e?.code==='P2003')return response.status(409).json({statusCode:409,code:'CAMPAIGN_CONFLICT',message:'A campaign resource changed or is still in use. Refresh and try again.'});
    if(e?.code==='P2025')return response.status(404).json({statusCode:404,code:'CAMPAIGN_NOT_FOUND',message:'Campaign resource not found.'});
    if(error instanceof HttpException&&error.getStatus()<500){
      const body=error.getResponse(),data=typeof body==='string'?{message:body}:body as Record<string,unknown>;
      if(error.getStatus()===416&&typeof data.rangeSize==='number')response.setHeader('Content-Range',`bytes */${data.rangeSize}`);
      return response.status(error.getStatus()).json({statusCode:error.getStatus(),code:data.code??'CAMPAIGN_REQUEST_REJECTED',message:data.message??'The campaign request could not be accepted.'});
    }
    // Busy is the one intentional public 503; provider/storage exceptions stay private.
    if(error instanceof HttpException){const data=error.getResponse() as Record<string,unknown>;if(data?.code==='XEEPRO_BUSY')return response.status(503).json(data);}
    Logger.warn('Campaign request failed ('+(e?.code??e?.name??'unknown')+')','Campaigns');
    return response.status(500).json({statusCode:500,code:'CAMPAIGN_REQUEST_FAILED',message:'The campaign request could not finish. Please try again.'});
  }
}
