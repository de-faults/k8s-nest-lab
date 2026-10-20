import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfig, logLevelsFromEnv } from './app-config.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // JSON logs are what a log shipper (Fluent Bit -> CloudWatch) expects in production.
    logger: new ConsoleLogger({
      json: process.env.LOG_FORMAT === 'json',
      logLevels: logLevelsFromEnv(),
    }),
    // Surface config errors as a normal exit code 1 instead of process.abort().
    abortOnError: false,
  });
  // Turns SIGTERM from the kubelet into a graceful app.close().
  app.enableShutdownHooks();
  await app.listen(app.get(AppConfig).port, '0.0.0.0');
}
await bootstrap();
