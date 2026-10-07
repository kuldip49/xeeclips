import { Body, Controller, Get, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, publicUser, sessionCookie } from './auth.service';
import { PrismaService } from '../database/prisma.service';
import { requestIdentity } from './request-context';
export function cookieToken(request: Request) { return request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(sessionCookie() + '='))?.slice(sessionCookie().length + 1); }
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly prisma: PrismaService) {}
  private async session(userId: string, req: Request, res: Response) {
    const value = await this.auth.issue(userId, cookieToken(req));
    res.cookie(sessionCookie(), value.token, { httpOnly: true, secure: process.env.AUTH_COOKIE_SECURE === 'true', sameSite: 'lax', path: '/', expires: value.expiresAt });
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUser });
  }
  @Post('signup') async signup(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.session((await this.auth.signup(body)).id, req, res); }
  @Post('login') async login(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.session(await this.auth.login(body), req, res); }
  @Post('logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { await this.auth.logout(cookieToken(req)); res.clearCookie(sessionCookie(), { httpOnly: true, secure: process.env.AUTH_COOKIE_SECURE === 'true', sameSite: 'lax', path: '/' }); return { loggedOut: true }; }
  @Get('session') sessionInfo(@Req() req: Request) { return this.auth.authenticate(cookieToken(req)); }
  @Patch('preferences') preferences(@Body() body: Record<string, unknown>) {
    return this.prisma.user.update({ where: { id: requestIdentity.getStore()!.userId! }, data: {
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName.trim().slice(0, 100) } : {}),
      ...(typeof body.aiProcessingConsent === 'boolean' ? { aiProcessingConsentAt: body.aiProcessingConsent ? new Date() : null } : {})
    }, select: publicUser });
  }
}
