import { Module } from '@nestjs/common';
import { IncidentsModule } from '../aiops/incidents.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [IncidentsModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
