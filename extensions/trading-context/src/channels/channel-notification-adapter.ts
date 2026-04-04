import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { NotificationAdapter } from "../halt/HaltProtocol.js";

/**
 * Phase 0 notification adapter — logs via the plugin logger.
 *
 * Phase 5 will upgrade this to route operator alerts through OpenClaw's
 * channel delivery system (Telegram, Discord, etc.) using the configured
 * delivery channel for the agent session.
 */
export class LoggerNotificationAdapter implements NotificationAdapter {
  private readonly logger: PluginLogger;
  private readonly prefix: string;

  constructor(opts: { logger: PluginLogger; prefix?: string }) {
    this.logger = opts.logger;
    this.prefix = opts.prefix ?? "[trading-context]";
  }

  async sendAlert(message: string): Promise<void> {
    this.logger.warn(`${this.prefix} HALT ALERT: ${message}`);
  }
}
