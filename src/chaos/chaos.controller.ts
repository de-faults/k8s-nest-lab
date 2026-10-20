import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AppConfig } from '../app-config.js';
import { ReadinessService } from '../health/readiness.service.js';

const MAX_CPU_BURN_MS = 2000;

// Fault-injection endpoints for the lab. Disabled unless CHAOS_ENABLED=true,
// which the production overlay leaves off.
@Controller('chaos')
export class ChaosController {
  private readonly logger = new Logger(ChaosController.name);

  constructor(
    private readonly config: AppConfig,
    private readonly readiness: ReadinessService,
  ) {}

  // Busy-loops on the event loop to drive CPU usage for the HPA exercise.
  @Get('cpu')
  cpu(@Query('ms', new ParseIntPipe({ optional: true })) ms = 200) {
    this.assertEnabled();
    const burnMs = Math.min(Math.max(ms, 0), MAX_CPU_BURN_MS);
    const end = Date.now() + burnMs;
    while (Date.now() < end) {
      // spin
    }
    return { burnedMs: burnMs, pod: this.config.pod.name };
  }

  @Post('crash')
  crash() {
    this.assertEnabled();
    this.logger.error('crash requested via /chaos/crash; exiting with code 1');
    setImmediate(() => process.exit(1));
    return { crashing: this.config.pod.name };
  }

  @Post('ready')
  setReady(@Query('state', ParseBoolPipe) state: boolean) {
    this.assertEnabled();
    this.readiness.setForcedUnready(!state);
    return { pod: this.config.pod.name, ready: this.readiness.isReady() };
  }

  private assertEnabled(): void {
    if (!this.config.chaosEnabled) throw new NotFoundException();
  }
}
