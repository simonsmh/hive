export const SOURCES = ["okx", "yahoo", "sina", "ths", "google"] as const;
export type Source = (typeof SOURCES)[number];

export const INTERVALS = ["1m", "5m", "15m", "1H", "1D"] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Candle {
  /** Bar open time in epoch milliseconds (UTC). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volCcy: number;
  confirmed: boolean;
}
