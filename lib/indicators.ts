// Technical Indicators Calculator

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Simple Moving Average (SMA)
export function calculateSMA(data: OHLCV[], period: number): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push({
      time: data[i].time,
      value: sum / period,
    });
  }

  return result;
}

// Exponential Moving Average (EMA)
export function calculateEMA(data: OHLCV[], period: number): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  const multiplier = 2 / (period + 1);

  // Start with SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  let ema = sum / period;
  result.push({ time: data[period - 1].time, value: ema });

  // Calculate EMA for rest
  for (let i = period; i < data.length; i++) {
    ema = (data[i].close - ema) * multiplier + ema;
    result.push({ time: data[i].time, value: ema });
  }

  return result;
}

// Bollinger Bands
export function calculateBollingerBands(
  data: OHLCV[],
  period: number = 20,
  stdDev: number = 2
): {
  upper: { time: number; value: number }[];
  middle: { time: number; value: number }[];
  lower: { time: number; value: number }[];
} {
  const upper: { time: number; value: number }[] = [];
  const middle: { time: number; value: number }[] = [];
  const lower: { time: number; value: number }[] = [];

  for (let i = period - 1; i < data.length; i++) {
    // Calculate SMA
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    const sma = sum / period;

    // Calculate Standard Deviation
    let squaredDiffSum = 0;
    for (let j = 0; j < period; j++) {
      squaredDiffSum += Math.pow(data[i - j].close - sma, 2);
    }
    const std = Math.sqrt(squaredDiffSum / period);

    middle.push({ time: data[i].time, value: sma });
    upper.push({ time: data[i].time, value: sma + stdDev * std });
    lower.push({ time: data[i].time, value: sma - stdDev * std });
  }

  return { upper, middle, lower };
}

// MACD (Moving Average Convergence Divergence)
export function calculateMACD(
  data: OHLCV[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): {
  macd: { time: number; value: number }[];
  signal: { time: number; value: number }[];
  histogram: { time: number; value: number; color: string }[];
} {
  const fastEMA = calculateEMA(data, fastPeriod);
  const slowEMA = calculateEMA(data, slowPeriod);

  // Align data - start from where both EMAs have values
  const startIndex = slowPeriod - fastPeriod;
  const macdLine: { time: number; value: number }[] = [];

  for (let i = 0; i < slowEMA.length; i++) {
    const fastValue = fastEMA[i + startIndex];
    const slowValue = slowEMA[i];
    if (fastValue && slowValue) {
      macdLine.push({
        time: slowValue.time,
        value: fastValue.value - slowValue.value,
      });
    }
  }

  // Calculate Signal Line (EMA of MACD)
  const signalLine: { time: number; value: number }[] = [];
  const multiplier = 2 / (signalPeriod + 1);

  if (macdLine.length >= signalPeriod) {
    let sum = 0;
    for (let i = 0; i < signalPeriod; i++) {
      sum += macdLine[i].value;
    }
    let ema = sum / signalPeriod;
    signalLine.push({ time: macdLine[signalPeriod - 1].time, value: ema });

    for (let i = signalPeriod; i < macdLine.length; i++) {
      ema = (macdLine[i].value - ema) * multiplier + ema;
      signalLine.push({ time: macdLine[i].time, value: ema });
    }
  }

  // Calculate Histogram
  const histogram: { time: number; value: number; color: string }[] = [];
  const signalStartIndex = signalPeriod - 1;

  for (let i = 0; i < signalLine.length; i++) {
    const macdValue = macdLine[i + signalStartIndex];
    const signalValue = signalLine[i];
    if (macdValue && signalValue) {
      const histValue = macdValue.value - signalValue.value;
      histogram.push({
        time: signalValue.time,
        value: histValue,
        color: histValue >= 0 ? 'rgba(38, 166, 154, 0.7)' : 'rgba(239, 83, 80, 0.7)',
      });
    }
  }

  return {
    macd: macdLine.slice(signalStartIndex),
    signal: signalLine,
    histogram,
  };
}

// RSI (Relative Strength Index)
export function calculateRSI(data: OHLCV[], period: number = 14): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate price changes
  for (let i = 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  // Calculate initial average gain and loss
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = 100 - (100 / (1 + rs));
  result.push({ time: data[period].time, value: rsi });

  // Calculate subsequent RSI values using smoothed averages
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
    result.push({ time: data[i + 1].time, value: rsi });
  }

  return result;
}

// Volume Moving Average
export function calculateVolumeMA(data: OHLCV[], period: number = 20): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].volume;
    }
    result.push({
      time: data[i].time,
      value: sum / period,
    });
  }

  return result;
}
