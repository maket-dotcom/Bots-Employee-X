import { Platform } from '../core/types';

/**
 * Every platform integration implements this interface. Adding a new
 * platform = one new adapter; the DB layer and ingestion pipeline stay
 * untouched.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
}
