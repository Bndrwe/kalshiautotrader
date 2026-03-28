import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Store Kalshi API credentials
export const apiConfig = sqliteTable("api_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  apiKeyId: text("api_key_id").notNull(),
  privateKeyPem: text("private_key_pem").notNull(),
  useDemo: integer("use_demo", { mode: "boolean" }).notNull().default(true),
});

// Trade log for the auto-trader
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  side: text("side").notNull(), // "yes" or "no"
  action: text("action").notNull(), // "buy" or "sell"
  count: integer("count").notNull(),
  priceCents: integer("price_cents").notNull(),
  orderId: text("order_id"),
  clientOrderId: text("client_order_id").notNull(),
  status: text("status").notNull().default("pending"), // pending, filled, cancelled, error
  pnlCents: integer("pnl_cents"), // realized P&L
  strategy: text("strategy"), // which strategy triggered it
  reason: text("reason"), // human readable reason
  createdAt: text("created_at").notNull(),
  settledAt: text("settled_at"),
  marketResult: text("market_result"), // "yes" or "no"
});

// Bot configuration
export const botConfig = sqliteTable("bot_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  maxTradesPerHour: integer("max_trades_per_hour").notNull().default(4),
  maxContractsPerTrade: integer("max_contracts_per_trade").notNull().default(1),
  maxLossCents: integer("max_loss_cents").notNull().default(500), // $5 stop loss
  targetAssets: text("target_assets").notNull().default("BTC,ETH,SOL"), // comma-separated
  strategy: text("strategy").notNull().default("momentum"), // momentum, mean_reversion, combined
  confidenceThreshold: real("confidence_threshold").notNull().default(0.6),
});

export const insertApiConfigSchema = createInsertSchema(apiConfig).omit({ id: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true });
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });

export type ApiConfig = typeof apiConfig.$inferSelect;
export type InsertApiConfig = z.infer<typeof insertApiConfigSchema>;
export type Trade = typeof trades.$inferSelect;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type BotConfig = typeof botConfig.$inferSelect;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
