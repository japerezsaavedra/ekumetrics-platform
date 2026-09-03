import { Module } from '@nestjs/common';
import { AlertmanagerModule } from '../alertmanager/alertmanager.module';
import { CorrelationService } from './correlation.service';
import { GraphService } from './graph.service';
import { IncidentsController } from './incidents.controller';

@Module({
  imports: [AlertmanagerModule],
  controllers: [IncidentsController],
  providers: [GraphService, CorrelationService],
  exports: [GraphService],
})
export class IncidentsModule {}
