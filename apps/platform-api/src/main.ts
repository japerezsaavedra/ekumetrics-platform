import './observability/tracing';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { corsOrigins } from './security-http';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
    }),
  );
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Eku-Tenant',
      'X-CSRF-Token',
    ],
    maxAge: 600,
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
