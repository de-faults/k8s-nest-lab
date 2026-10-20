import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig } from '../app-config.js';

@Injectable()
export class ReadinessService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ReadinessService.name);
  private shuttingDown = false;
  private forcedUnready = false;

  constructor(private readonly config: AppConfig) {}

  isReady(): boolean {
    return !this.shuttingDown && !this.forcedUnready;
  }

  setForcedUnready(value: boolean): void {
    this.forcedUnready = value;
    this.logger.warn(`readiness forced ${value ? 'DOWN' : 'UP'}`);
  }

  // Kubernetes removes the pod from Service endpoints in parallel with sending
  // SIGTERM, so keep serving for a moment while kube-proxy / the load balancer
  // catch up. Without this delay a rolling update drops in-flight requests.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.logger.log(
      `${signal ?? 'shutdown'} received; draining for ${this.config.shutdownDelayMs}ms`,
    );
    await sleep(this.config.shutdownDelayMs);
  }
}
