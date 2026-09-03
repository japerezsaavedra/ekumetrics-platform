import { Module } from '@nestjs/common';
import { AlertChannelsService } from './alert-channels.service';
import { AlertmanagerController } from './alertmanager.controller';
import { AlertmanagerService } from './alertmanager.service';

@Module({
  controllers: [AlertmanagerController],
  providers: [AlertmanagerService, AlertChannelsService],
  exports: [AlertmanagerService],
})
export class AlertmanagerModule {}
