import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:4200';
  app.enableCors({
    origin: [
      origin,
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://10.10.0.2:4200',
      'http://localhost',
      'http://127.0.0.1',
    ],
    credentials: true,
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
