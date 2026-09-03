import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Public } from '../auth/public';
import { IngestService } from './ingest.service';

@Public()
@Controller('v1/ekms')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post('events')
  @HttpCode(202)
  ingest(
    @Body() body: unknown,
    @Headers('x-ekumetrics-ingest-key') ingestKey?: string,
    @Headers('x-ekumetrics-client-dn') clientDn?: string,
    @Headers('x-ekumetrics-edge-assertion') edgeAssertion?: string,
  ) {
    return this.ingestService.ingest(body, ingestKey, clientDn, edgeAssertion);
  }
}
