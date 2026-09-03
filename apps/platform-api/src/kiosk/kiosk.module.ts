import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';

@Module({
  controllers: [KioskController],
  providers: [KioskService],
  exports: [KioskService],
})
export class KioskModule {}
