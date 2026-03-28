import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { KalshiClient } from "./kalshi";
import { generateSignals, executeTrade, getPriceHistory } from "./trading-engine";

// SSE clients for live updates
let sseClients: Array<{ id: number; res: any }> = [];
let sseId = 0;

function broadcast(event: string, data: any) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.res.write(msg); } catch {}
  });
}

// The series tickers for 15-min up/down crypto markets
const UP_DOWN_SERIES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M", "KXDOGE15M"];

// Polling interval for market data
let pollingInterval: NodeJS.Timeout | null = null;
let tradingInterval: NodeJS.Timeout | null = null;

// Cache for market data
let cachedMarkets: any[] = [];
let lastMarketFetch = 0;

async function fetchAllMarkets(useDemo: boolean): Promise<any[]> {
  const allMarkets: any[] = [];
  for (const series of UP_DOWN_SERIES) {
    try {
      const markets = await KalshiClient.getPublicMarkets(series, "open", useDemo);
      allMarkets.push(...markets);
    } catch (e) {
      // Silently skip failed series
    }
  }
  return allMarkets;
}

function getClient(): KalshiClient | null {
  const config = storage.getApiConfig();
  if (!config) return null;
  try {
    return new KalshiClient(config.apiKeyId, config.privateKeyPem, config.useDemo ?? true);
  } catch {
    return null;
  }
}

// Start polling for live market data
function startPolling() {
  if (pollingInterval) return;

  pollingInterval = setInterval(async () => {
    try {
      const config = storage.getApiConfig();
      const useDemo = config?.useDemo ?? true;
      const markets = await fetchAllMarkets(useDemo);
      cachedMarkets = markets;
      lastMarketFetch = Date.now();
      broadcast("markets", { markets, timestamp: lastMarketFetch });

      // Generate signals for the bot
      const botConfig = storage.getBotConfig();
      if (botConfig.enabled) {
        const targetAssets = botConfig.targetAssets.split(",").map(s => s.trim());
        const activeMarkets = markets.filter(m => {
          const asset = m.ticker.match(/KX([A-Z]+)15M/)?.[1];
          return asset && targetAssets.includes(asset);
        });

        const allSignals: any[] = [];
        for (const market of activeMarkets) {
          const signals = generateSignals(market, botConfig);
          allSignals.push(...signals);
        }

        if (allSignals.length > 0) {
          broadcast("signals", { signals: allSignals });
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
    }
  }, 10000); // Every 10 seconds
}

// Auto-trading loop
function startTradingLoop() {
  if (tradingInterval) return;

  tradingInterval = setInterval(async () => {
    const botConfig = storage.getBotConfig();
    if (!botConfig.enabled) return;

    const client = getClient();
    if (!client) return;

    const targetAssets = botConfig.targetAssets.split(",").map(s => s.trim());

    for (const market of cachedMarkets) {
      const asset = market.ticker.match(/KX([A-Z]+)15M/)?.[1];
      if (!asset || !targetAssets.includes(asset)) continue;

      const signals = generateSignals(market, botConfig);
      const bestSignal = signals
        .filter(s => s.confidence >= botConfig.confidenceThreshold)
        .sort((a, b) => b.confidence - a.confidence)[0];

      if (bestSignal) {
        const result = await executeTrade(bestSignal, client, botConfig);
        broadcast("trade", {
          signal: bestSignal,
          result,
          timestamp: Date.now(),
        });
      }
    }
  }, 15000); // Check every 15 seconds
}

export async function registerRoutes(server: Server, app: Express) {
  // SSE endpoint for live updates
  app.get("/api/sse", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const clientId = ++sseId;
    sseClients.push({ id: clientId, res });

    // Send initial data
    res.write(`event: connected\ndata: ${JSON.stringify({ id: clientId })}\n\n`);
    if (cachedMarkets.length > 0) {
      res.write(`event: markets\ndata: ${JSON.stringify({ markets: cachedMarkets, timestamp: lastMarketFetch })}\n\n`);
    }

    req.on("close", () => {
      sseClients = sseClients.filter(c => c.id !== clientId);
    });
  });

  // Get markets (cached or fresh)
  app.get("/api/markets", async (req, res) => {
    try {
      if (Date.now() - lastMarketFetch < 5000 && cachedMarkets.length > 0) {
        return res.json({ markets: cachedMarkets });
      }
      const config = storage.getApiConfig();
      const useDemo = config?.useDemo ?? true;
      const markets = await fetchAllMarkets(useDemo);
      cachedMarkets = markets;
      lastMarketFetch = Date.now();
      res.json({ markets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get market orderbook
  app.get("/api/markets/:ticker/orderbook", async (req, res) => {
    try {
      const config = storage.getApiConfig();
      const useDemo = config?.useDemo ?? true;
      const data = await KalshiClient.getOrderbook(req.params.ticker, 10, useDemo);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get market trades
  app.get("/api/markets/:ticker/trades", async (req, res) => {
    try {
      const config = storage.getApiConfig();
      const useDemo = config?.useDemo ?? true;
      const trades = await KalshiClient.getPublicTrades(req.params.ticker, 50, useDemo);
      res.json({ trades });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API Config
  app.get("/api/config", (req, res) => {
    const config = storage.getApiConfig();
    if (!config) return res.json({ configured: false });
    res.json({
      configured: true,
      apiKeyId: config.apiKeyId.slice(0, 8) + "...",
      useDemo: config.useDemo,
    });
  });

  app.post("/api/config", (req, res) => {
    try {
      const { apiKeyId, privateKeyPem, useDemo } = req.body;
      if (!apiKeyId || !privateKeyPem) {
        return res.status(400).json({ error: "apiKeyId and privateKeyPem required" });
      }
      const config = storage.upsertApiConfig({
        apiKeyId,
        privateKeyPem,
        useDemo: useDemo ?? true,
      });
      res.json({ success: true, apiKeyId: config.apiKeyId.slice(0, 8) + "..." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Portfolio endpoints (authenticated)
  app.get("/api/portfolio/balance", async (req, res) => {
    const client = getClient();
    if (!client) return res.status(400).json({ error: "API not configured" });
    try {
      const balance = await client.getBalance();
      res.json(balance);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/portfolio/positions", async (req, res) => {
    const client = getClient();
    if (!client) return res.status(400).json({ error: "API not configured" });
    try {
      const positions = await client.getPositions();
      res.json({ positions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual order placement
  app.post("/api/orders", async (req, res) => {
    const client = getClient();
    if (!client) return res.status(400).json({ error: "API not configured" });
    try {
      const { ticker, action, side, count, yes_price, no_price } = req.body;
      const clientOrderId = require("uuid").v4();
      const order = await client.createOrder({
        ticker,
        action: action || "buy",
        side,
        count: count || 1,
        yes_price,
        no_price,
        client_order_id: clientOrderId,
      });

      // Log to trades table
      storage.createTrade({
        ticker,
        side,
        action: action || "buy",
        count: count || 1,
        priceCents: yes_price || no_price || 0,
        orderId: order.order_id,
        clientOrderId,
        status: order.status === "resting" ? "pending" : "filled",
        strategy: "manual",
        reason: "Manual trade",
        createdAt: new Date().toISOString(),
      });

      res.json({ order });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bot config
  app.get("/api/bot/config", (req, res) => {
    res.json(storage.getBotConfig());
  });

  app.put("/api/bot/config", (req, res) => {
    try {
      const updated = storage.updateBotConfig(req.body);

      // Start/stop trading loop based on enabled status
      if (updated.enabled) {
        startTradingLoop();
      } else if (tradingInterval) {
        clearInterval(tradingInterval);
        tradingInterval = null;
      }

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trade history
  app.get("/api/trades", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json({ trades: storage.getTrades(limit) });
  });

  app.get("/api/trades/stats", (req, res) => {
    res.json(storage.getTradeStats());
  });

  // Price history for charts
  app.get("/api/price-history/:asset", (req, res) => {
    const history = getPriceHistory();
    const data = history.get(req.params.asset.toUpperCase()) || [];
    res.json({ history: data });
  });

  // Signals endpoint
  app.get("/api/signals", (req, res) => {
    const botConfig = storage.getBotConfig();
    const targetAssets = botConfig.targetAssets.split(",").map(s => s.trim());
    const allSignals: any[] = [];

    for (const market of cachedMarkets) {
      const asset = market.ticker.match(/KX([A-Z]+)15M/)?.[1];
      if (!asset || !targetAssets.includes(asset)) continue;
      const signals = generateSignals(market, botConfig);
      allSignals.push(...signals);
    }

    res.json({ signals: allSignals });
  });

  // Start market data polling
  startPolling();

  // If bot was previously enabled, restart trading loop
  const botConfig = storage.getBotConfig();
  if (botConfig.enabled) {
    startTradingLoop();
  }
}
