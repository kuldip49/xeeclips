import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { OwnershipInterceptor } from './ownership.interceptor';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SecurityGuard } from './security.guard';
import { UsageService } from './usage.service';
import { AdminController } from './admin.controller';
@Global()
@Module({ providers: [AuthService, UsageService, { provide: APP_GUARD, useClass: SecurityGuard }, { provide: APP_INTERCEPTOR, useClass: OwnershipInterceptor }],
  controllers: [AuthController, AdminController], exports: [AuthService, UsageService] })
export class AuthModule {}
