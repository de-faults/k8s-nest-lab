import { Injectable, LogLevel } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const LOG_LEVELS: LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

// Fail at boot so a bad ConfigMap value surfaces as CrashLoopBackOff instead of odd runtime behavior.
export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${name}="${raw}": expected a non-negative integer`,
    );
  }
  return value;
}

// LOG_LEVEL=debug enables fatal..debug, i.e. the given level and everything more severe.
export function logLevelsFromEnv(): LogLevel[] {
  const raw = (process.env.LOG_LEVEL ?? 'log') as LogLevel;
  const index = LOG_LEVELS.indexOf(raw);
  if (index === -1) {
    throw new Error(
      `Invalid LOG_LEVEL="${raw}": expected one of ${LOG_LEVELS.join(', ')}`,
    );
  }
  return LOG_LEVELS.slice(0, index + 1);
}

export type FileConfig =
  | { path: string; loaded: true; data: unknown }
  | { path: string; loaded: false; error: string };

@Injectable()
export class AppConfig {
  readonly appName = process.env.APP_NAME ?? 'nest-lab';
  readonly appEnv = process.env.APP_ENV ?? 'local';
  readonly appVersion = process.env.APP_VERSION ?? 'dev';
  readonly logLevel = process.env.LOG_LEVEL ?? 'log';
  readonly greeting = process.env.GREETING ?? 'Hello from nest-lab';
  readonly port = intFromEnv('PORT', 3000);
  readonly shutdownDelayMs = intFromEnv('SHUTDOWN_DELAY_MS', 0);
  readonly chaosEnabled = process.env.CHAOS_ENABLED === 'true';
  readonly configFilePath =
    process.env.CONFIG_FILE_PATH ?? '/etc/nest-lab/app-config.json';

  // Downward API values; fall back to local values when running outside Kubernetes.
  readonly pod = {
    name: process.env.POD_NAME ?? hostname(),
    namespace: process.env.POD_NAMESPACE ?? null,
    ip: process.env.POD_IP ?? null,
    node: process.env.NODE_NAME ?? null,
  };

  // Read on every call on purpose: the kubelet updates a ConfigMap mounted as a
  // volume in place, while env vars stay frozen until the pod is recreated.
  readFileConfig(): FileConfig {
    try {
      const data: unknown = JSON.parse(
        readFileSync(this.configFilePath, 'utf8'),
      );
      return { path: this.configFilePath, loaded: true, data };
    } catch (err) {
      return {
        path: this.configFilePath,
        loaded: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Never echo the secret itself; show just enough to tell a rotation happened.
  apiKeyFingerprint(): string | null {
    const key = process.env.API_KEY;
    if (!key) return null;
    return `${key.slice(0, 2)}***${key.slice(-2)} (len=${key.length})`;
  }
}
