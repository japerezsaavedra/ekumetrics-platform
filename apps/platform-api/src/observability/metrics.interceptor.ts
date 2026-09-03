import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{ method?: string }>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number }>();
    const startedAt = process.hrtime.bigint();
    const route = this.route(context);
    const record = (statusCode: number) => {
      const seconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.observe(
        request.method ?? 'UNKNOWN',
        route,
        statusCode,
        seconds,
      );
    };
    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (error: { getStatus?: () => number }) =>
          record(error.getStatus?.() ?? 500),
      }),
    );
  }

  private route(context: ExecutionContext) {
    const controller = Reflect.getMetadata(
      PATH_METADATA,
      context.getClass(),
    ) as string | undefined;
    const handler = Reflect.getMetadata(PATH_METADATA, context.getHandler()) as
      string | undefined;
    const segments = [controller, handler]
      .filter(Boolean)
      .map((segment) => String(segment).replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    return `/${segments.join('/')}`;
  }
}
