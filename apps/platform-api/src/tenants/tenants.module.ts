import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [TenantsController, AdminController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
