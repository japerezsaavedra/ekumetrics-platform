import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:4200';
  app.enableCors({ origin, credentials: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
