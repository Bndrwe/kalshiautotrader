import { v4 as uuidv4 } from "uuid";
import { KalshiClient, type KalshiMarket } from "./kalshi";
import { storage } from "./storage";
import type { BotConfig } from "@shared/schema";

// Market data cache for strategy signals
interface MarketSnapshot {
  ticker: string;
  asset: string;
  yesBid: number;
  yesAsk: number;
  lastPrice: number;
  volume24h: number;
  openInterest: number;
  closeTime: string;
  timestamp: number;
}

// Rolling window of snapshots for each asset
const priceHistory: Map<string, MarketSnapshot[]> = new Map();
const MAX_HISTORY = 60; // Keep last 60 snapshots (~10min at 10s intervals)

// Track trades per hour for rate limiting
let tradesThisHour: number[] = [];

export interface TradeSignal {
  ticker: string;
  asset: string;
  side: "yes" | "no"; // yes = up, no = down
  confidence: number; // 0-1
  strategy: string;
  reason: string;
  suggestedPrice: number; // in cents 1-99
}

/**
 * Momentum Strategy
 * Looks at recent price movement direction and volume to predict continuation.
 * If yes price has been trending up with increasing volume, buy yes (up).
 * Works well in trending 15-min windows.
 */
function momentumSignal(snapshots: MarketSnapshot[]): { side: "yes" | "no"; confidence: number; reason: string } | null {
  if (snapshots.length < 6) return null;

  const recent = snapshots.slice(-6);
  const older = snapshots.slice(-12, -6);
  if (older.length < 3) return null;

  // Calculate price trend
  const recentAvgPrice = recent.reduce((s, m) => s + m.lastPrice, 0) / recent.length;
  const olderAvgPrice = older.reduce((s, m) => s + m.lastPrice, 0) / older.length;
  const priceDelta = recentAvgPrice - olderAvgPrice;

  // Volume trend (increasing volume confirms momentum)
  const recentAvgVol = recent.reduce((s, m) => s + m.volume24h, 0) / recent.length;
  const olderAvgVol = older.reduce((s, m) => s + m.volume24h, 0) / older.length;
  const volumeRatio = olderAvgVol > 0 ? recentAvgVol / olderAvgVol : 1;

  // Need meaningful price movement (at least 2 cents)
  if (Math.abs(priceDelta) < 0.02) return null;

  const direction: "yes" | "no" = priceDelta > 0 ? "yes" : "no";
  let confidence = Math.min(Math.abs(priceDelta) * 10, 0.5); // Base: price delta
  if (volumeRatio > 1.1) confidence += 0.15; // Volume confirmation
  if (volumeRatio > 1.3) confidence += 0.1;

  // Check consistency (how many recent snapshots agree with direction)
  const consistentCount = recent.filter((m, i) => {
    if (i === 0) return true;
    return direction === "yes"
      ? m.lastPrice >= recent[i - 1].lastPrice
      : m.lastPrice <= recent[i - 1].lastPrice;
  }).length;
  const consistency = consistentCount / recent.length;
  confidence *= consistency;

  confidence = Math.min(confidence, 0.85);

  if (confidence < 0.3) return null;

  return {
    side: direction,
    confidence,
    reason: `Momentum ${direction === "yes" ? "UP" : "DOWN"}: price Δ=${(priceDelta * 100).toFixed(1)}¢, vol ratio=${volumeRatio.toFixed(2)}, consistency=${(consistency * 100).toFixed(0)}%`,
  };
}

/**
 * Mean Reversion Strategy
 * When price moves too far from 50¢ (fair value for a coin flip), 
 * bet on reversion. Crypto up/down markets tend to revert when 
 * one side gets too cheap.
 */
function meanReversionSignal(snapshots: MarketSnapshot[]): { side: "yes" | "no"; confidence: number; reason: string } | null {
  if (snapshots.length < 4) return null;

  const latest = snapshots[snapshots.length - 1];
  const price = latest.lastPrice;

  // Fair value is ~0.50 for a binary up/down market
  const deviation = price - 0.50;

  // Need significant deviation from fair value (>8 cents)
  if (Math.abs(deviation) < 0.08) return null;

  // If yes is cheap (price < 42¢), buy yes (market will revert up)
  // If yes is expensive (price > 58¢), buy no (market will revert down)
  const side: "yes" | "no" = deviation < 0 ? "yes" : "no";

  // Check if deviation is increasing (overreaction) or decreasing (already reverting)
  const prevPrices = snapshots.slice(-4).map(s => s.lastPrice);
  const isStillExtending = side === "yes"
    ? prevPrices[prevPrices.length - 1] < prevPrices[0]
    : prevPrices[prevPrices.length - 1] > prevPrices[0];

  let confidence = Math.min(Math.abs(deviation) * 3, 0.6);

  // Don't catch falling knives - wait for stabilization
  if (isStillExtending) {
    confidence *= 0.5;
  } else {
    confidence += 0.1; // Reversal starting
  }

  // Spread check - tight spread means more liquid/confident market
  const spread = latest.yesAsk - latest.yesBid;
  if (spread < 0.03) confidence += 0.05;
  if (spread > 0.08) confidence -= 0.1;

  confidence = Math.max(0, Math.min(confidence, 0.8));

  if (confidence < 0.3) return null;

  return {
    side,
    confidence,
    reason: `Mean reversion: yes@${(price * 100).toFixed(0)}¢, deviation=${(deviation * 100).toFixed(1)}¢ from fair, ${isStillExtending ? "extending" : "stabilizing"}, spread=${(spread * 100).toFixed(1)}¢`,
  };
}

/**
 * Spread/Value Strategy
 * Looks for markets where bid-ask spread creates value.
 * If we can buy at a price that gives us an edge based on historical win rates.
 */
function spreadValueSignal(snapshots: MarketSnapshot[]): { side: "yes" | "no"; confidence: number; reason: string } | null {
  if (snapshots.length < 3) return null;

  const latest = snapshots[snapshots.length - 1];
  const spread = latest.yesAsk - latest.yesBid;

  // Wide spread = opportunity if we can get filled near the bid
  if (spread < 0.04) return null; // Too tight, no edge

  // Check which side has better value
  // If yesBid is below 45¢, there might be value buying yes at bid
  // If yesBid is above 55¢, there might be value buying no
  const yesBidCents = latest.yesBid;
  const noImpliedBid = 1 - latest.yesAsk;

  let side: "yes" | "no";
  let edgePrice: number;

  if (yesBidCents < 0.45 && yesBidCents > 0.10) {
    side = "yes";
    edgePrice = yesBidCents;
  } else if (noImpliedBid > 0 && latest.yesAsk > 0.55 && latest.yesAsk < 0.90) {
    side = "no";
    edgePrice = noImpliedBid;
  } else {
    return null;
  }

  let confidence = spread * 3; // Wider spread = more potential profit
  if (latest.openInterest > 100) confidence += 0.05;

  confidence = Math.max(0, Math.min(confidence, 0.65));
  if (confidence < 0.3) return null;

  return {
    side,
    confidence,
    reason: `Spread value: ${side} side, spread=${(spread * 100).toFixed(1)}¢, edge at ${(edgePrice * 100).toFixed(0)}¢`,
  };
}

/**
 * Generate trading signals for a given asset's current market
 */
export function generateSignals(market: KalshiMarket, config: BotConfig): TradeSignal[] {
  const asset = extractAsset(market.ticker);
  const key = asset;

  const snapshot: MarketSnapshot = {
    ticker: market.ticker,
    asset,
    yesBid: parseFloat(market.yes_bid_dollars || "0"),
    yesAsk: parseFloat(market.yes_ask_dollars || "0"),
    lastPrice: parseFloat(market.last_price_dollars || "0"),
    volume24h: parseFloat(market.volume_24h_fp || "0"),
    openInterest: parseFloat(market.open_interest_fp || "0"),
    closeTime: market.close_time,
    timestamp: Date.now(),
  };

  // Store snapshot
  if (!priceHistory.has(key)) priceHistory.set(key, []);
  const history = priceHistory.get(key)!;
  history.push(snapshot);
  if (history.length > MAX_HISTORY) history.shift();

  const signals: TradeSignal[] = [];
  const strategy = config.strategy;

  // Skip if market is about to close (less than 2 minutes)
  const closeTime = new Date(market.close_time).getTime();
  const now = Date.now();
  if (closeTime - now < 2 * 60 * 1000) return signals;

  // Skip if no liquidity
  if (snapshot.yesBid === 0 || snapshot.yesAsk === 0) return signals;

  if (strategy === "momentum" || strategy === "combined") {
    const mom = momentumSignal(history);
    if (mom) {
      const price = mom.side === "yes"
        ? Math.round(snapshot.yesAsk * 100)
        : Math.round((1 - snapshot.yesBid) * 100);
      signals.push({
        ticker: market.ticker,
        asset,
        side: mom.side,
        confidence: mom.confidence,
        strategy: "momentum",
        reason: mom.reason,
        suggestedPrice: Math.max(1, Math.min(99, price)),
      });
    }
  }

  if (strategy === "mean_reversion" || strategy === "combined") {
    const mr = meanReversionSignal(history);
    if (mr) {
      const price = mr.side === "yes"
        ? Math.round(snapshot.yesBid * 100) + 1
        : Math.round((1 - snapshot.yesAsk) * 100) + 1;
      signals.push({
        ticker: market.ticker,
        asset,
        side: mr.side,
        confidence: mr.confidence,
        strategy: "mean_reversion",
        reason: mr.reason,
        suggestedPrice: Math.max(1, Math.min(99, price)),
      });
    }
  }

  if (strategy === "combined") {
    const sv = spreadValueSignal(history);
    if (sv) {
      const price = sv.side === "yes"
        ? Math.round(snapshot.yesBid * 100) + 1
        : Math.round((1 - snapshot.yesAsk) * 100) + 1;
      signals.push({
        ticker: market.ticker,
        asset,
        side: sv.side,
        confidence: sv.confidence,
        strategy: "spread_value",
        reason: sv.reason,
        suggestedPrice: Math.max(1, Math.min(99, price)),
      });
    }
  }

  return signals;
}

function extractAsset(ticker: string): string {
  // KXBTC15M-26MAR281315-15 -> BTC
  const match = ticker.match(/KX([A-Z]+)15M/);
  return match ? match[1] : ticker.split("-")[0];
}

/**
 * Execute a trade based on a signal
 */
export async function executeTrade(
  signal: TradeSignal,
  client: KalshiClient,
  config: BotConfig
): Promise<{ success: boolean; trade?: any; error?: string }> {
  // Rate limit check
  const now = Date.now();
  tradesThisHour = tradesThisHour.filter(t => now - t < 3600000);
  if (tradesThisHour.length >= config.maxTradesPerHour) {
    return { success: false, error: "Rate limit: max trades per hour reached" };
  }

  // Loss limit check
  const stats = storage.getTradeStats();
  if (stats.pnlCents < -config.maxLossCents) {
    return { success: false, error: `Loss limit reached: $${(Math.abs(stats.pnlCents) / 100).toFixed(2)}` };
  }

  const clientOrderId = uuidv4();
  const count = config.maxContractsPerTrade;

  try {
    const order = await client.createOrder({
      ticker: signal.ticker,
      action: "buy",
      side: signal.side,
      count,
      type: "limit",
      yes_price: signal.side === "yes" ? signal.suggestedPrice : undefined,
      no_price: signal.side === "no" ? signal.suggestedPrice : undefined,
      client_order_id: clientOrderId,
      time_in_force: "good_till_canceled",
    });

    const trade = storage.createTrade({
      ticker: signal.ticker,
      side: signal.side,
      action: "buy",
      count,
      priceCents: signal.suggestedPrice,
      orderId: order.order_id,
      clientOrderId,
      status: order.status === "resting" ? "pending" : "filled",
      strategy: signal.strategy,
      reason: signal.reason,
      createdAt: new Date().toISOString(),
    });

    tradesThisHour.push(now);

    return { success: true, trade };
  } catch (err: any) {
    const trade = storage.createTrade({
      ticker: signal.ticker,
      side: signal.side,
      action: "buy",
      count,
      priceCents: signal.suggestedPrice,
      orderId: null,
      clientOrderId,
      status: "error",
      strategy: signal.strategy,
      reason: `${signal.reason} | ERROR: ${err.message}`,
      createdAt: new Date().toISOString(),
    });

    return { success: false, error: err.message, trade };
  }
}

export function getPriceHistory(): Map<string, MarketSnapshot[]> {
  return priceHistory;
}

export function clearHistory(): void {
  priceHistory.clear();
}
