import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { publicErrorMessage } from './public-response.interceptor';

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res=host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status=error.getStatus(),body=error.getResponse();
      const data=typeof body==='string'?{message:body}:body as Record<string,unknown>;
      if (data.code==='XEEPRO_BUSY') return res.status(503).json({statusCode:503,code:'XEEPRO_BUSY',message:'XeePro is busy right now. Try XeeFree or try again later.'});
      const message=status>=500?'Processing could not finish. Please try again.':publicErrorMessage(data.message??'The request could not be accepted.');
      return res.status(status).json({statusCode:status,...(typeof data.code==='string'&&/^[A-Z_]+$/.test(data.code)?{code:data.code}:{}),message});
    }
    Logger.error(error instanceof Error?error.stack:error,'PublicRequest');
    return res.status(500).json({statusCode:500,message:'The request could not finish. Please try again.'});
  }
}
