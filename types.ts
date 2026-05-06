
export interface TokenPosition {
  coin: string;
  size: number;
  isLong: boolean;
}

export interface Token {
  id: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  createdAt: number;
  marketCap: number;
  bondingCurveProgress: number; // 0 to 100
  price: number;
  priceChange24h: number;
  priceChange: number; // Price change from first candle (used by AdvancedChart)
  imageUrl: string;
  volume24h: number;
  holders: number;
  // New fields from API
  nav?: string;
  buyPrice?: string;
  tvl?: string;
  totalVolume?: string;
  performanceFeeBps?: number;
  leader?: string;
  core?: string;
  trading?: string;
  totalSupply?: string;
  metadataURI?: string;
  verified?: boolean;
  positions?: TokenPosition[]; // L1 perp positions
  winRate?: number;  // L1 trading win rate (0-1)
  apy?: number;      // Annual percentage yield
}

export interface Trade {
  id: string;
  tokenId: string;
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  user: string;
  timestamp: number;
}

export interface Comment {
  id: string;
  user: string;
  text: string;
  timestamp: number;
}
