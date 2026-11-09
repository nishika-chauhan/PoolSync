export interface PoolData {
  id: number;
  pubkey: string;
  mintA: string;
  mintB: string;
  reserveA: number; // in token units (e.g. SOL)
  reserveB: number; // in token units (e.g. USDC)
  reserveARaw: string;
  reserveBRaw: string;
  k: string; // raw BigInt representation
  spotPrice: number; // reserveB / reserveA
  feeBps: number;
  optedIn: boolean;
  coordinator: string;
  policy: {
    maxPriceDivergenceBps: number;
    minIntervalSlots: number;
    maxSingleRebalanceBps: number;
    authorizedCoordinator: string;
  };
}

export interface HopTransfer {
  poolId: number;
  transferX: number; // signed change in X (raw)
  transferY: number; // signed change in Y (raw)
}

export interface RebalanceEventRecord {
  id: string;
  signature: string;
  slot: number;
  timestamp: number;
  poolsInvolved: number[];
  transfers: HopTransfer[];
  prePrices: number[];
  postPrices: number[];
  counterfactualArbProfit: number;
  valueRetainedPct: number;
  verified: boolean;
  verificationDetails?: {
    conservationHolds: boolean;
    kMonotonicityHolds: boolean;
    arbitrageFreeCrossMulHolds: boolean;
    valueRetainedMatched: boolean;
    deviations: string[];
  };
}

export interface VerificationResult {
  signature: string;
  isValid: boolean;
  checks: {
    name: string;
    description: string;
    passed: boolean;
    actual: string;
    expected: string;
  }[];
  timestamp: number;
}
