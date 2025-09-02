import { useMemo, useState } from "react";
import "./App.css";

type OptionSide = {
  strike: number;
  type: "call" | "put";
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  iv?: number | null; // percent in our app
};
type ExpirySlice = { expiry: string; options: OptionSide[] };

type YieldRow = {
  strike: number;
  bid: number;
  yieldPct: number;
  probOTM: number; // percent
  delta?: number | null;
  iv?: number | null;
  expiry: string;
  side: "call" | "put";
};

const DTE_BUCKETS = [7, 14, 21, 30] as const;

export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [chainLoading, setChainLoading] = useState(false);
  const [chainErr, setChainErr] = useState("");
  const [expiries, setExpiries] = useState<ExpirySlice[]>([]);
  const [uPrice, setUPrice] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  /* ---------- Derived: Top Yields (OTM only) ---------- */
  const topYields = useMemo(() => {
    if (!expiries.length || uPrice == null) return null;

    const now = Date.now();
    const expWithDte = expiries.map((ex) => ({
      ex,
      dte: Math.max(0, Math.ceil((Date.parse(ex.expiry) - now) / (1000 * 60 * 60 * 24))),
    }));

    const result: Record<
      number,
      { calls: YieldRow[]; puts: YieldRow[]; cMin: number; cMax: number; pMin: number; pMax: number }
    > = {};

    for (const target of DTE_BUCKETS) {
      const nearest = expWithDte
        .slice()
        .sort((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target
