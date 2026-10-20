import { Controller, Get } from '@nestjs/common';
import { AppConfig } from './app-config.js';

@Controller()
export class AppController {
  constructor(private readonly config: AppConfig) {}

  @Get()
  info() {
    return {
      app: this.config.appName,
      env: this.config.appEnv,
      version: this.config.appVersion,
      message: this.config.greeting,
      pod: this.config.pod,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  // Compares the two ways a ConfigMap reaches a container: env (frozen at
  // container start) vs. mounted file (refreshed by the kubelet).
  @Get('config')
  configSnapshot() {
    return {
      fromEnv: {
        APP_ENV: this.config.appEnv,
        LOG_LEVEL: this.config.logLevel,
        GREETING: this.config.greeting,
        CHAOS_ENABLED: this.config.chaosEnabled,
        SHUTDOWN_DELAY_MS: this.config.shutdownDelayMs,
      },
      fromFile: this.config.readFileConfig(),
      secret: { API_KEY: this.config.apiKeyFingerprint() },
    };
  }
}
