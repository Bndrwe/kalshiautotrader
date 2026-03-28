import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  TrendingUp, TrendingDown, Activity, Zap, Settings, DollarSign,
  ArrowUpRight, ArrowDownRight, AlertTriangle, Clock, BarChart3,
  Bot, Wifi, WifiOff, ChevronUp, ChevronDown,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";

interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  status: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  volume_24h_fp: string;
  open_interest_fp: string;
  close_time: string;
  previous_price_dollars: string;
  yes_sub_title: string;
  no_sub_title: string;
}

interface TradeRecord {
  id: number;
  ticker: string;
  side: string;
  action: string;
  count: number;
  priceCents: number;
  orderId: string | null;
  status: string;
  pnlCents: number | null;
  strategy: string | null;
  reason: string | null;
  createdAt: string;
}

interface Signal {
  ticker: string;
  asset: string;
  side: string;
  confidence: number;
  strategy: string;
  reason: string;
  suggestedPrice: number;
}

interface BotConfig {
  id: number;
  enabled: boolean;
  maxTradesPerHour: number;
  maxContractsPerTrade: number;
  maxLossCents: number;
  targetAssets: string;
  strategy: string;
  confidenceThreshold: number;
}

function extractAsset(ticker: string): string {
  const match = ticker.match(/KX([A-Z]+)15M/);
  return match ? match[1] : ticker.split("-")[0];
}

function formatDollars(dollarStr: string): string {
  const val = parseFloat(dollarStr);
  if (isNaN(val)) return "-";
  return `${(val * 100).toFixed(0)}¢`;
}

function formatTimeLeft(closeTime: string): string {
  const diff = new Date(closeTime).getTime() - Date.now();
  if (diff < 0) return "Closed";
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

const ASSET_ICONS: Record<string, string> = {
  BTC: "₿", ETH: "⟠", SOL: "◎", XRP: "✕", DOGE: "Ð",
};

const ASSET_COLORS: Record<string, string> = {
  BTC: "text-orange-400",
  ETH: "text-blue-400",
  SOL: "text-purple-400",
  XRP: "text-cyan-400",
  DOGE: "text-yellow-400",
};

export default function Dashboard() {
  const { toast } = useToast();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [connected, setConnected] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [priceData, setPriceData] = useState<Record<string, Array<{ time: string; price: number }>>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [, setTick] = useState(0);

  // Force re-render for countdown timers
  useEffect(() => {
    timerRef.current = setInterval(() => setTick(t => t + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // SSE connection for live data
  useEffect(() => {
    const connect = () => {
      const es = new EventSource("./api/sse");
      eventSourceRef.current = es;

      es.addEventListener("connected", () => setConnected(true));
      es.addEventListener("markets", (e) => {
        const data = JSON.parse(e.data);
        setMarkets(data.markets);
        // Build price chart data
        const now = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setPriceData(prev => {
          const next = { ...prev };
          for (const m of data.markets) {
            const asset = extractAsset(m.ticker);
            const price = parseFloat(m.last_price_dollars) * 100;
            if (!next[asset]) next[asset] = [];
            next[asset] = [...next[asset], { time: now, price }].slice(-60);
          }
          return next;
        });
      });
      es.addEventListener("signals", (e) => {
        const data = JSON.parse(e.data);
        setSignals(data.signals);
      });
      es.addEventListener("trade", (e) => {
        const data = JSON.parse(e.data);
        queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
        queryClient.invalidateQueries({ queryKey: ["/api/trades/stats"] });
        if (data.result?.success) {
          toast({
            title: "Trade Executed",
            description: `${data.signal.side.toUpperCase()} ${data.signal.asset} @ ${data.signal.suggestedPrice}¢ (${data.signal.strategy})`,
          });
        }
      });
      es.onerror = () => {
        setConnected(false);
        es.close();
        setTimeout(connect, 5000);
      };
    };
    connect();
    return () => eventSourceRef.current?.close();
  }, [toast]);

  // Queries
  const { data: apiConfig } = useQuery({
    queryKey: ["/api/config"],
    queryFn: () => apiRequest("GET", "/api/config").then(r => r.json()),
  });
  const { data: botConfig, refetch: refetchBot } = useQuery<BotConfig>({
    queryKey: ["/api/bot/config"],
    queryFn: () => apiRequest("GET", "/api/bot/config").then(r => r.json()),
  });
  const { data: tradeData } = useQuery({
    queryKey: ["/api/trades"],
    queryFn: () => apiRequest("GET", "/api/trades?limit=50").then(r => r.json()),
    refetchInterval: 10000,
  });
  const { data: statsData } = useQuery({
    queryKey: ["/api/trades/stats"],
    queryFn: () => apiRequest("GET", "/api/trades/stats").then(r => r.json()),
    refetchInterval: 10000,
  });

  const toggleBot = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/bot/config", { enabled });
      return res.json();
    },
    onSuccess: () => {
      refetchBot();
      toast({
        title: botConfig?.enabled ? "Bot Stopped" : "Bot Started",
        description: botConfig?.enabled ? "Auto-trading disabled" : "Auto-trading is now active",
      });
    },
  });

  const updateBotConfig = useMutation({
    mutationFn: async (data: Partial<BotConfig>) => {
      const res = await apiRequest("PUT", "/api/bot/config", data);
      return res.json();
    },
    onSuccess: () => refetchBot(),
  });

  // Group markets by asset
  const marketsByAsset = markets.reduce<Record<string, Market[]>>((acc, m) => {
    const asset = extractAsset(m.ticker);
    if (!acc[asset]) acc[asset] = [];
    acc[asset].push(m);
    return acc;
  }, {});

  // Get most relevant (nearest closing, still open) market per asset
  const activeMarkets = Object.entries(marketsByAsset).map(([asset, ms]) => {
    const open = ms.filter(m => m.status === "active" || m.status === "open");
    if (open.length === 0) return null;
    open.sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
    return { asset, market: open[0], allMarkets: open };
  }).filter(Boolean) as Array<{ asset: string; market: Market; allMarkets: Market[] }>;

  const stats = statsData || { total: 0, wins: 0, losses: 0, pnlCents: 0 };
  const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : "0.0";
  const trades: TradeRecord[] = tradeData?.trades || [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between" data-testid="header">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-label="Kalshi Trader">
              <rect x="2" y="2" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5" className="text-primary"/>
              <path d="M8 20V8l6 6 6-6v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary"/>
            </svg>
            <span className="font-semibold text-sm tracking-tight">Kalshi Trader</span>
          </div>
          <Badge variant={connected ? "default" : "destructive"} className="text-xs gap-1" data-testid="status-connection">
            {connected ? <Wifi className="w-3 h-3"/> : <WifiOff className="w-3 h-3"/>}
            {connected ? "Live" : "Disconnected"}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-muted-foreground"/>
            <span className="text-xs text-muted-foreground">Auto-Trade</span>
            <Switch
              checked={botConfig?.enabled || false}
              onCheckedChange={(checked) => toggleBot.mutate(checked)}
              data-testid="switch-bot-toggle"
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowSettings(!showSettings)} data-testid="button-settings">
            <Settings className="w-4 h-4"/>
          </Button>
        </div>
      </header>

      <main className="p-4 space-y-4 max-w-[1600px] mx-auto">
        {/* Settings Panel */}
        {showSettings && <SettingsPanel config={botConfig} onUpdate={updateBotConfig.mutate} apiConfig={apiConfig} />}

        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPICard
            label="Win Rate"
            value={`${winRate}%`}
            icon={<BarChart3 className="w-4 h-4"/>}
            detail={`${stats.wins}W / ${stats.losses}L`}
            color={parseFloat(winRate) >= 50 ? "text-emerald-400" : "text-red-400"}
          />
          <KPICard
            label="Total P&L"
            value={`${stats.pnlCents >= 0 ? "+" : ""}$${(stats.pnlCents / 100).toFixed(2)}`}
            icon={<DollarSign className="w-4 h-4"/>}
            detail={`${stats.total} trades`}
            color={stats.pnlCents >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <KPICard
            label="Active Markets"
            value={`${activeMarkets.length}`}
            icon={<Activity className="w-4 h-4"/>}
            detail="Up/Down 15m"
            color="text-blue-400"
          />
          <KPICard
            label="Bot Status"
            value={botConfig?.enabled ? "Active" : "Off"}
            icon={<Zap className="w-4 h-4"/>}
            detail={botConfig?.strategy || "combined"}
            color={botConfig?.enabled ? "text-emerald-400" : "text-muted-foreground"}
          />
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Market Cards */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4"/>
              Live Markets — Crypto Up/Down (15 min)
            </h2>
            {activeMarkets.length === 0 ? (
              <Card className="bg-card border-card-border">
                <CardContent className="p-8 text-center text-muted-foreground">
                  <Clock className="w-8 h-8 mx-auto mb-2 opacity-50"/>
                  <p className="text-sm">Waiting for market data...</p>
                  <p className="text-xs mt-1">Markets refresh every 10 seconds</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeMarkets.map(({ asset, market, allMarkets }) => (
                  <MarketCard
                    key={asset}
                    asset={asset}
                    market={market}
                    allMarkets={allMarkets}
                    priceData={priceData[asset] || []}
                    signal={signals.find(s => s.asset === asset)}
                    selected={selectedMarket === market.ticker}
                    onSelect={() => setSelectedMarket(selectedMarket === market.ticker ? null : market.ticker)}
                  />
                ))}
              </div>
            )}

            {/* Signals */}
            {signals.length > 0 && (
              <Card className="bg-card border-card-border">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Zap className="w-4 h-4 text-yellow-400"/>
                    Active Signals
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="space-y-2">
                    {signals.map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded-md bg-muted/30 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`font-mono font-bold ${ASSET_COLORS[s.asset] || "text-foreground"}`}>
                            {ASSET_ICONS[s.asset] || ""} {s.asset}
                          </span>
                          <Badge variant={s.side === "yes" ? "default" : "destructive"} className="text-[10px] px-1.5 py-0">
                            {s.side === "yes" ? "UP" : "DOWN"}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{s.strategy}</Badge>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground">{s.suggestedPrice}¢</span>
                          <ConfidenceBar confidence={s.confidence}/>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Trade Log */}
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <BarChart3 className="w-4 h-4"/>
              Trade Log
            </h2>
            <Card className="bg-card border-card-border">
              <CardContent className="p-0">
                <div className="max-h-[500px] overflow-y-auto">
                  {trades.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-xs">
                      No trades yet. Enable the bot or place a manual trade.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {trades.map((trade) => (
                        <TradeRow key={trade.id} trade={trade}/>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* P&L Chart */}
            {trades.length > 0 && (
              <Card className="bg-card border-card-border">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm">Cumulative P&L</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <PnLChart trades={trades}/>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function KPICard({ label, value, icon, detail, color }: {
  label: string; value: string; icon: React.ReactNode; detail: string; color: string;
}) {
  return (
    <Card className="bg-card border-card-border">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div className={`text-xl font-bold font-mono tabular-nums ${color}`}>{value}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{detail}</div>
      </CardContent>
    </Card>
  );
}

function MarketCard({ asset, market, allMarkets, priceData, signal, selected, onSelect }: {
  asset: string; market: Market; allMarkets: Market[];
  priceData: Array<{ time: string; price: number }>;
  signal?: Signal; selected: boolean; onSelect: () => void;
}) {
  const lastPrice = parseFloat(market.last_price_dollars) * 100;
  const prevPrice = parseFloat(market.previous_price_dollars || "0") * 100;
  const delta = lastPrice - prevPrice;
  const isUp = delta >= 0;
  const timeLeft = formatTimeLeft(market.close_time);
  const volume = parseFloat(market.volume_24h_fp || "0");

  return (
    <Card
      className={`bg-card border-card-border cursor-pointer transition-all hover:border-primary/30 ${selected ? "ring-1 ring-primary/50" : ""}`}
      onClick={onSelect}
      data-testid={`card-market-${asset}`}
    >
      <CardContent className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`text-lg font-bold ${ASSET_COLORS[asset] || "text-foreground"}`}>
              {ASSET_ICONS[asset] || ""} 
            </span>
            <div>
              <span className="font-semibold text-sm">{asset}</span>
              <span className="text-[10px] text-muted-foreground ml-1.5">15m Up/Down</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5">
              <Clock className="w-2.5 h-2.5"/>
              {timeLeft}
            </Badge>
            {signal && (
              <Badge variant={signal.side === "yes" ? "default" : "destructive"} className="text-[10px] px-1.5 py-0 animate-pulse">
                {signal.side === "yes" ? "↑" : "↓"} {(signal.confidence * 100).toFixed(0)}%
              </Badge>
            )}
          </div>
        </div>

        {/* Price */}
        <div className="flex items-end justify-between mb-2">
          <div>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {lastPrice.toFixed(0)}¢
            </div>
            <div className={`text-xs flex items-center gap-0.5 ${isUp ? "text-emerald-400" : "text-red-400"}`}>
              {isUp ? <ChevronUp className="w-3 h-3"/> : <ChevronDown className="w-3 h-3"/>}
              {Math.abs(delta).toFixed(1)}¢
            </div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            <div>Bid: {formatDollars(market.yes_bid_dollars)}</div>
            <div>Ask: {formatDollars(market.yes_ask_dollars)}</div>
            <div>Vol: {volume.toFixed(0)}</div>
          </div>
        </div>

        {/* Sparkline */}
        {priceData.length > 2 && (
          <div className="h-12 -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={priceData}>
                <defs>
                  <linearGradient id={`grad-${asset}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={isUp ? "#34d399" : "#f87171"} stopOpacity={0.3}/>
                    <stop offset="100%" stopColor={isUp ? "#34d399" : "#f87171"} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={isUp ? "#34d399" : "#f87171"}
                  strokeWidth={1.5}
                  fill={`url(#grad-${asset})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Bid/Ask bar */}
        <div className="mt-2">
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-emerald-400">Up {formatDollars(market.yes_bid_dollars)}</span>
            <span className="text-red-400">{formatDollars(market.no_bid_dollars || "0")} Down</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden flex">
            <div
              className="bg-emerald-500/70 rounded-l-full transition-all"
              style={{ width: `${lastPrice}%` }}
            />
            <div
              className="bg-red-500/70 rounded-r-full transition-all flex-1"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }}/>
      </div>
      <span className="text-[10px] font-mono w-7 text-right">{pct}%</span>
    </div>
  );
}

function TradeRow({ trade }: { trade: TradeRecord }) {
  const asset = extractAsset(trade.ticker);
  const isWin = (trade.pnlCents ?? 0) > 0;
  const isSettled = trade.status === "settled";

  return (
    <div className="px-3 py-2 flex items-center justify-between text-xs" data-testid={`row-trade-${trade.id}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`font-mono font-bold ${ASSET_COLORS[asset] || ""}`}>
          {ASSET_ICONS[asset] || ""}{asset}
        </span>
        <Badge
          variant={trade.side === "yes" ? "default" : "destructive"}
          className="text-[10px] px-1 py-0 shrink-0"
        >
          {trade.side === "yes" ? "UP" : "DN"}
        </Badge>
        <span className="text-muted-foreground truncate">{trade.strategy}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-mono">{trade.priceCents}¢</span>
        {isSettled ? (
          <span className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>
            {(trade.pnlCents ?? 0) >= 0 ? "+" : ""}{((trade.pnlCents ?? 0) / 100).toFixed(2)}
          </span>
        ) : (
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            {trade.status}
          </Badge>
        )}
      </div>
    </div>
  );
}

function PnLChart({ trades }: { trades: TradeRecord[] }) {
  const settled = trades
    .filter(t => t.status === "settled" && t.pnlCents !== null)
    .reverse();

  let cum = 0;
  const data = settled.map((t, i) => {
    cum += (t.pnlCents ?? 0);
    return { idx: i + 1, pnl: cum / 100 };
  });

  if (data.length < 2) return null;

  const lastPnl = data[data.length - 1]?.pnl ?? 0;
  const color = lastPnl >= 0 ? "#34d399" : "#f87171";

  return (
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3}/>
              <stop offset="100%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(225, 20%, 16%)" vertical={false}/>
          <XAxis dataKey="idx" hide/>
          <YAxis hide domain={["auto", "auto"]}/>
          <Tooltip
            contentStyle={{ background: "hsl(225, 28%, 10%)", border: "1px solid hsl(225, 20%, 16%)", borderRadius: "6px", fontSize: "11px" }}
            labelStyle={{ color: "hsl(220, 10%, 58%)" }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, "P&L"]}
          />
          <Area
            type="monotone"
            dataKey="pnl"
            stroke={color}
            strokeWidth={2}
            fill="url(#pnlGrad)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function SettingsPanel({ config, onUpdate, apiConfig }: {
  config?: BotConfig; onUpdate: (data: Partial<BotConfig>) => void; apiConfig: any;
}) {
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [useDemo, setUseDemo] = useState(true);

  const saveApiConfig = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/config", {
        apiKeyId: apiKey,
        privateKeyPem: privateKey,
        useDemo,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      toast({ title: "API keys saved" });
      setApiKey("");
      setPrivateKey("");
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card className="bg-card border-card-border">
      <CardContent className="p-4">
        <Tabs defaultValue="bot" className="w-full">
          <TabsList className="mb-3">
            <TabsTrigger value="bot">Bot Settings</TabsTrigger>
            <TabsTrigger value="api">API Keys</TabsTrigger>
          </TabsList>
          <TabsContent value="bot" className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label className="text-xs">Strategy</Label>
                <Select
                  value={config?.strategy || "combined"}
                  onValueChange={(v) => onUpdate({ strategy: v })}
                >
                  <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-strategy">
                    <SelectValue/>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="momentum">Momentum</SelectItem>
                    <SelectItem value="mean_reversion">Mean Reversion</SelectItem>
                    <SelectItem value="combined">Combined</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Confidence Threshold</Label>
                <Input
                  type="number"
                  min={0.1}
                  max={0.99}
                  step={0.05}
                  value={config?.confidenceThreshold || 0.6}
                  onChange={(e) => onUpdate({ confidenceThreshold: parseFloat(e.target.value) })}
                  className="mt-1 h-8 text-xs font-mono"
                  data-testid="input-confidence"
                />
              </div>
              <div>
                <Label className="text-xs">Max Trades/Hour</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={config?.maxTradesPerHour || 4}
                  onChange={(e) => onUpdate({ maxTradesPerHour: parseInt(e.target.value) })}
                  className="mt-1 h-8 text-xs font-mono"
                  data-testid="input-max-trades"
                />
              </div>
              <div>
                <Label className="text-xs">Contracts/Trade</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={config?.maxContractsPerTrade || 1}
                  onChange={(e) => onUpdate({ maxContractsPerTrade: parseInt(e.target.value) })}
                  className="mt-1 h-8 text-xs font-mono"
                  data-testid="input-contracts"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Max Loss ($)</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={(config?.maxLossCents || 500) / 100}
                  onChange={(e) => onUpdate({ maxLossCents: Math.round(parseFloat(e.target.value) * 100) })}
                  className="mt-1 h-8 text-xs font-mono"
                  data-testid="input-max-loss"
                />
              </div>
              <div>
                <Label className="text-xs">Target Assets (comma-separated)</Label>
                <Input
                  value={config?.targetAssets || "BTC,ETH,SOL"}
                  onChange={(e) => onUpdate({ targetAssets: e.target.value })}
                  className="mt-1 h-8 text-xs font-mono"
                  data-testid="input-assets"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500"/>
              <span className="text-[10px] text-muted-foreground">
                Bot trades with real money when API keys are configured. Start with 1 contract and low confidence threshold to test.
              </span>
            </div>
          </TabsContent>
          <TabsContent value="api" className="space-y-3">
            {apiConfig?.configured && (
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <Wifi className="w-3 h-3"/>
                Connected: {apiConfig.apiKeyId} ({apiConfig.useDemo ? "Demo" : "Production"})
              </div>
            )}
            <div>
              <Label className="text-xs">API Key ID</Label>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="a952bcbe-ec3b-4b5b-..."
                className="mt-1 h-8 text-xs font-mono"
                data-testid="input-api-key"
              />
            </div>
            <div>
              <Label className="text-xs">Private Key (PEM)</Label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                className="mt-1 w-full h-20 px-3 py-2 text-xs font-mono bg-background border border-input rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="input-private-key"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={useDemo} onCheckedChange={setUseDemo} data-testid="switch-demo"/>
              <Label className="text-xs">Use Demo API (recommended for testing)</Label>
            </div>
            <Button
              size="sm"
              onClick={() => saveApiConfig.mutate()}
              disabled={!apiKey || !privateKey || saveApiConfig.isPending}
              className="text-xs"
              data-testid="button-save-api"
            >
              Save API Keys
            </Button>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
