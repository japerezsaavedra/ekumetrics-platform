import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public';
import { MetricsService } from './metrics.service';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render() {
    return this.metrics.render();
  }
}
