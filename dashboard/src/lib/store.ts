import { PoolData, RebalanceEventRecord } from "../types/pool";

// In-memory persistent state across API routes within the server process
interface GlobalState {
  pools: PoolData[];
  events: RebalanceEventRecord[];
  network: "localnet" | "devnet";
}

const INITIAL_POOLS: PoolData[] = [
  {
    id: 0,
    pubkey: "Pool011111111111111111111111111111111111111",
    mintA: "So11111111111111111111111111111111111111112",
    mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    reserveA: 1000.0,
    reserveB: 100000.0,
    reserveARaw: "1000000000000",
    reserveBRaw: "100000000000",
    k: "100000000000000000000000",
    spotPrice: 100.0,
    feeBps: 30,
    optedIn: true,
    coordinator: "Coord11111111111111111111111111111111111111",
    policy: {
      maxPriceDivergenceBps: 1000,
      minIntervalSlots: 0,
      maxSingleRebalanceBps: 2000,
      authorizedCoordinator: "Coord11111111111111111111111111111111111111",
    },
  },
  {
    id: 1,
    pubkey: "Pool111111111111111111111111111111111111111",
    mintA: "So11111111111111111111111111111111111111112",
    mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    reserveA: 1000.0,
    reserveB: 105000.0,
    reserveARaw: "1000000000000",
    reserveBRaw: "105000000000",
    k: "105000000000000000000000",
    spotPrice: 105.0,
    feeBps: 30,
    optedIn: true,
    coordinator: "Coord11111111111111111111111111111111111111",
    policy: {
      maxPriceDivergenceBps: 1000,
      minIntervalSlots: 0,
      maxSingleRebalanceBps: 2000,
      authorizedCoordinator: "Coord11111111111111111111111111111111111111",
    },
  },
];

const INITIAL_EVENTS: RebalanceEventRecord[] = [
  {
    id: "evt-init-genesis",
    signature: "5KqZ1bK9hW3mZqJ4u7Vw8Y2xG1pL6cN5tD8rE3fA2sB4C6dE8gH1jK2lM3nP4qR7",
    slot: 12450,
    timestamp: Date.now() - 1000 * 60 * 18,
    poolsInvolved: [0, 1],
    transfers: [
      { poolId: 0, transferX: -12195121951, transferY: 1248456000 },
      { poolId: 1, transferX: 12195121951, transferY: -1248456000 },
    ],
    prePrices: [98.0, 102.5],
    postPrices: [100.25, 100.25],
    counterfactualArbProfit: 27.85,
    valueRetainedPct: 100.0,
    verified: true,
    verificationDetails: {
      conservationHolds: true,
      kMonotonicityHolds: true,
      arbitrageFreeCrossMulHolds: true,
      valueRetainedMatched: true,
      deviations: [],
    },
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __POOLSYNC_STATE__: GlobalState | undefined;
}

if (!global.__POOLSYNC_STATE__) {
  global.__POOLSYNC_STATE__ = {
    pools: JSON.parse(JSON.stringify(INITIAL_POOLS)),
    events: JSON.parse(JSON.stringify(INITIAL_EVENTS)),
    network: "localnet",
  };
}

export const getStore = (): GlobalState => {
  return global.__POOLSYNC_STATE__!;
};

export const resetStore = () => {
  global.__POOLSYNC_STATE__ = {
    pools: JSON.parse(JSON.stringify(INITIAL_POOLS)),
    events: JSON.parse(JSON.stringify(INITIAL_EVENTS)),
    network: "localnet",
  };
};
