import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';

export const publicUser = { id: true, email: true, displayName: true, role: true, status: true,
  creditBalance: true, creditsConsumed: true, aiProcessingConsentAt: true, createdAt: true, lastLoginAt: true } as const;
export const sessionCookie = () => process.env.AUTH_COOKIE_SECURE === 'true' ? '__Host-xeeclip-session' : 'xeeclip-session';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function normalizeEmail(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('Enter a valid email address.');
  return value.trim().toLowerCase();
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value, 'utf8') > 72) throw new BadRequestException('Use a password of at least 12 characters and at most 72 bytes.');
}
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash!: string;
  constructor(private readonly prisma: PrismaService) {}
  async onModuleInit() {
    this.dummyHash = await hash(randomBytes(32).toString('hex'), 12);
    if (process.env.NODE_ENV === 'production' && process.env.AUTH_COOKIE_SECURE !== 'true') throw new Error('Production requires AUTH_COOKIE_SECURE=true');
    if (process.env.NODE_ENV === 'production' && !(process.env.FRONTEND_ORIGIN ?? '').split(',').includes('https://xeeclip.me')) throw new Error('Production requires the explicit https://xeeclip.me frontend origin.');
    const email = process.env.ADMIN_EMAIL;
    if (!email) return;
    const normalized = normalizeEmail(email);
    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (existing) {
      if (existing.role !== 'ADMIN') throw new Error('ADMIN_EMAIL belongs to a normal account; use the secure bootstrap procedure.');
      return; // Never change an existing password at startup.
    }
    if (await this.prisma.user.count({ where: { role: 'ADMIN' } })) throw new Error('An owner admin already exists.');
    validatePassword(process.env.ADMIN_INITIAL_PASSWORD);
    await this.prisma.user.create({ data: { email: normalized, displayName: 'Owner', role: 'ADMIN', passwordHash: await hash(process.env.ADMIN_INITIAL_PASSWORD, 12) } });
    this.logger.log('auth_admin_bootstrapped');
  }
  async signup(body: Record<string, unknown>) {
    const email = normalizeEmail(body.email); validatePassword(body.password);
    const credits = Number(process.env.DEFAULT_USER_CREDITS ?? 5);
    if (!Number.isSafeInteger(credits) || credits < 0 || credits > 1000000) throw new Error('Invalid DEFAULT_USER_CREDITS');
    try {
      return await this.prisma.user.create({ data: { email, passwordHash: await hash(body.password, 12),
        displayName: typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 100) : '', creditBalance: credits,
        transactions: { create: { amount: credits, type: 'INITIAL_GRANT', reason: 'Welcome credits' } } }, select: publicUser });
    } catch (e: any) { if (e.code === 'P2002') throw new ConflictException('Unable to create this account. Try logging in.'); throw e; }
  }
  async login(body: Record<string, unknown>) {
    const email = normalizeEmail(body.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const password = typeof body.password === 'string' && Buffer.byteLength(body.password) <= 72 ? body.password : '';
    const valid = await compare(password, user?.passwordHash ?? this.dummyHash);
    if (!user || !valid) { this.logger.warn('auth_login_failed_credentials'); throw new UnauthorizedException('Email or password is incorrect.'); }
    if (user.status !== 'ACTIVE') { this.logger.warn('auth_login_failed_suspended'); throw new UnauthorizedException('Your account is currently unavailable.'); }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.logger.log('auth_login_success'); return user.id;
  }
  async issue(userId: string, previous?: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    await this.prisma.$transaction(async tx => {
      if (previous) await tx.session.deleteMany({ where: { tokenHash: digest(previous) } });
      await tx.session.create({ data: { tokenHash: digest(token), userId, expiresAt } });
    });
    return { token, expiresAt };
  }
  async authenticate(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException('Please log in.');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: { select: publicUser } } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('Please log in.');
    if (session.user.status !== 'ACTIVE') throw new UnauthorizedException('Your account is currently unavailable.');
    return session.user;
  }
  async logout(token?: string) { if (token) await this.prisma.session.deleteMany({ where: { tokenHash: digest(token) } }); }
}
