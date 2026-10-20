import { Module } from '@nestjs/common';
import { AppConfig } from './app-config.js';
import { AppController } from './app.controller.js';
import { ChaosController } from './chaos/chaos.controller.js';
import { HealthController } from './health/health.controller.js';
import { ReadinessService } from './health/readiness.service.js';

@Module({
  controllers: [AppController, HealthController, ChaosController],
  providers: [AppConfig, ReadinessService],
})
export class AppModule {}
