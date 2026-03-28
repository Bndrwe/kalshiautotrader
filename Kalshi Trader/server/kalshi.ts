import crypto from "crypto";
import fetch from "node-fetch";

const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  status: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  volume_24h_fp: string;
  open_interest_fp: string;
  close_time: string;
  open_time: string;
  result: string | null;
  can_close_early: boolean;
  previous_price_dollars: string;
  previous_yes_bid_dollars: string;
  previous_yes_ask_dollars: string;
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: string;
  action: string;
  type: string;
  status: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  initial_count_fp: string;
  created_time: string;
}

export class KalshiClient {
  private apiKeyId: string;
  private privateKey: crypto.KeyObject;
  private baseUrl: string;

  constructor(apiKeyId: string, privateKeyPem: string, useDemo = true) {
    this.apiKeyId = apiKeyId;
    this.privateKey = crypto.createPrivateKey({
      key: privateKeyPem,
      format: "pem",
    });
    this.baseUrl = useDemo ? DEMO_BASE : PROD_BASE;
  }

  private sign(timestamp: string, method: string, path: string): string {
    // Strip query params for signing
    const pathWithoutQuery = path.split("?")[0];
    const message = `${timestamp}${method}${pathWithoutQuery}`;
    const signature = crypto.sign("sha256", Buffer.from(message), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString("base64");
  }

  private getHeaders(method: string, path: string): Record<string, string> {
    const timestamp = String(Date.now());
    const fullPath = `/trade-api/v2${path}`;
    return {
      "KALSHI-ACCESS-KEY": this.apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": this.sign(timestamp, method, fullPath),
      "Content-Type": "application/json",
    };
  }

  async get(path: string): Promise<any> {
    const headers = this.getHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async post(path: string, body: any): Promise<any> {
    const headers = this.getHeaders("POST", path);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async delete(path: string): Promise<any> {
    const headers = this.getHeaders("DELETE", path);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi DELETE ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // Public endpoints (no auth needed)
  static async getPublicMarkets(seriesTicker: string, status?: string, useDemo = true): Promise<KalshiMarket[]> {
    const base = useDemo ? DEMO_BASE : PROD_BASE;
    let url = `${base}/markets?series_ticker=${seriesTicker}&limit=100`;
    if (status) url += `&status=${status}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.markets || [];
  }

  static async getPublicMarket(ticker: string, useDemo = true): Promise<KalshiMarket | null> {
    const base = useDemo ? DEMO_BASE : PROD_BASE;
    const res = await fetch(`${base}/markets/${ticker}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.market || null;
  }

  static async getPublicTrades(ticker: string, limit = 50, useDemo = true): Promise<any[]> {
    const base = useDemo ? DEMO_BASE : PROD_BASE;
    const res = await fetch(`${base}/markets/trades?ticker=${ticker}&limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.trades || [];
  }

  static async getOrderbook(ticker: string, depth = 10, useDemo = true): Promise<any> {
    const base = useDemo ? DEMO_BASE : PROD_BASE;
    const res = await fetch(`${base}/markets/${ticker}/orderbook?depth=${depth}`);
    if (!res.ok) return null;
    return res.json();
  }

  // Authenticated endpoints
  async getBalance(): Promise<{ balance: number; payout: number }> {
    const data = await this.get("/portfolio/balance");
    return data;
  }

  async getPositions(): Promise<any[]> {
    const data = await this.get("/portfolio/positions?limit=100");
    return data.market_positions || [];
  }

  async getOrders(status?: string): Promise<KalshiOrder[]> {
    let path = "/portfolio/orders?limit=100";
    if (status) path += `&status=${status}`;
    const data = await this.get(path);
    return data.orders || [];
  }

  async createOrder(params: {
    ticker: string;
    action: "buy" | "sell";
    side: "yes" | "no";
    count: number;
    type?: "limit" | "market";
    yes_price?: number;
    no_price?: number;
    client_order_id: string;
    time_in_force?: string;
  }): Promise<KalshiOrder> {
    const body: any = {
      ticker: params.ticker,
      action: params.action,
      side: params.side,
      count: params.count,
      type: params.type || "limit",
      client_order_id: params.client_order_id,
    };
    if (params.yes_price !== undefined) body.yes_price = params.yes_price;
    if (params.no_price !== undefined) body.no_price = params.no_price;
    if (params.time_in_force) body.time_in_force = params.time_in_force;

    const data = await this.post("/portfolio/orders", body);
    return data.order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.delete(`/portfolio/orders/${orderId}`);
  }
}
