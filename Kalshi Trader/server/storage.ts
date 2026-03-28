import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";
import {
  apiConfig, trades, botConfig,
  type ApiConfig, type InsertApiConfig,
  type Trade, type InsertTrade,
  type BotConfig, type InsertBotConfig,
} from "@shared/schema";

const sqlite = new Database("sqlite.db");
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite);

export interface IStorage {
  // API Config
  getApiConfig(): ApiConfig | undefined;
  upsertApiConfig(data: InsertApiConfig): ApiConfig;

  // Trades
  getTrades(limit?: number): Trade[];
  createTrade(data: InsertTrade): Trade;
  updateTrade(id: number, data: Partial<Trade>): void;
  getTradeStats(): { total: number; wins: number; losses: number; pnlCents: number };

  // Bot Config
  getBotConfig(): BotConfig;
  updateBotConfig(data: Partial<BotConfig>): BotConfig;
}

export class SqliteStorage implements IStorage {
  constructor() {
    // Ensure tables exist
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS api_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        use_demo INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        count INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        order_id TEXT,
        client_order_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pnl_cents INTEGER,
        strategy TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        settled_at TEXT,
        market_result TEXT
      );
      CREATE TABLE IF NOT EXISTS bot_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled INTEGER NOT NULL DEFAULT 0,
        max_trades_per_hour INTEGER NOT NULL DEFAULT 4,
        max_contracts_per_trade INTEGER NOT NULL DEFAULT 1,
        max_loss_cents INTEGER NOT NULL DEFAULT 500,
        target_assets TEXT NOT NULL DEFAULT 'BTC,ETH,SOL',
        strategy TEXT NOT NULL DEFAULT 'momentum',
        confidence_threshold REAL NOT NULL DEFAULT 0.6
      );
    `);
  }

  getApiConfig(): ApiConfig | undefined {
    return db.select().from(apiConfig).get();
  }

  upsertApiConfig(data: InsertApiConfig): ApiConfig {
    const existing = this.getApiConfig();
    if (existing) {
      db.update(apiConfig).set(data).where(eq(apiConfig.id, existing.id)).run();
      return db.select().from(apiConfig).where(eq(apiConfig.id, existing.id)).get()!;
    }
    return db.insert(apiConfig).values(data).returning().get();
  }

  getTrades(limit = 100): Trade[] {
    return db.select().from(trades).orderBy(desc(trades.id)).limit(limit).all();
  }

  createTrade(data: InsertTrade): Trade {
    return db.insert(trades).values(data).returning().get();
  }

  updateTrade(id: number, data: Partial<Trade>): void {
    db.update(trades).set(data).where(eq(trades.id, id)).run();
  }

  getTradeStats(): { total: number; wins: number; losses: number; pnlCents: number } {
    const allTrades = db.select().from(trades).all();
    const settled = allTrades.filter(t => t.status === "settled");
    const wins = settled.filter(t => (t.pnlCents ?? 0) > 0).length;
    const losses = settled.filter(t => (t.pnlCents ?? 0) <= 0).length;
    const pnlCents = settled.reduce((sum, t) => sum + (t.pnlCents ?? 0), 0);
    return { total: settled.length, wins, losses, pnlCents };
  }

  getBotConfig(): BotConfig {
    const existing = db.select().from(botConfig).get();
    if (existing) return existing;
    return db.insert(botConfig).values({}).returning().get();
  }

  updateBotConfig(data: Partial<BotConfig>): BotConfig {
    const existing = this.getBotConfig();
    db.update(botConfig).set(data).where(eq(botConfig.id, existing.id)).run();
    return db.select().from(botConfig).where(eq(botConfig.id, existing.id)).get()!;
  }
}

export const storage = new SqliteStorage();
