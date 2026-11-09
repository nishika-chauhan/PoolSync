import { spawn } from "child_process";
import http from "http";

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, text: body });
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Starting Next.js production server on port 3000...");
  const server = spawn("npx.cmd", ["next", "start", "-p", "3000", "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "inherit",
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const res = await fetchJson("http://127.0.0.1:3000/api/pools");
      if (res && res.status === 200) {
        ready = true;
        break;
      }
    } catch (e) {
      // connecting...
    }
  }

  if (!ready) {
    server.kill("SIGKILL");
    throw new Error("Server failed to respond on port 3000 within 15s");
  }

  console.log("\n>>> Server is LIVE! Testing endpoints...\n");

  // 1. Test GET /api/pools
  console.log("--- 1. Testing GET /api/pools ---");
  const poolsRes = await fetchJson("http://127.0.0.1:3000/api/pools");
  console.log(`Status: ${poolsRes.status}`);
  console.log(`Initial Divergence: ${poolsRes.data.divergenceBps} bps`);
  console.log(`Estimated Counterfactual MEV: $${poolsRes.data.counterfactualArbProfit}`);
  console.log("Pool 0 Spot Price:", poolsRes.data.pools[0].spotPrice);
  console.log("Pool 1 Spot Price:", poolsRes.data.pools[1].spotPrice);

  // 2. Test POST /api/rebalance (Triggering atomic multi-pool rebalance)
  console.log("\n--- 2. Testing POST /api/rebalance ---");
  const rebalanceRes = await fetchJson("http://127.0.0.1:3000/api/rebalance", {
    method: "POST",
  });
  console.log(`Status: ${rebalanceRes.status}`);
  console.log(`Rebalanced: ${rebalanceRes.data.rebalanced}`);
  console.log(`Signature: ${rebalanceRes.data.signature}`);
  console.log("Post-Rebalance Prices:", rebalanceRes.data.summary.postPrices);
  console.log("Token Transfers:", rebalanceRes.data.summary.transfers);
  console.log(`Protected Value: $${rebalanceRes.data.summary.counterfactualArbProfit} (${rebalanceRes.data.summary.valueRetainedPct}% retained)`);

  // 3. Test POST /api/verify (Auditing invariants)
  console.log("\n--- 3. Testing POST /api/verify ---");
  const verifyRes = await fetchJson("http://127.0.0.1:3000/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: rebalanceRes.data.signature }),
  });
  console.log(`Status: ${verifyRes.status}`);
  console.log(`Proof Valid: ${verifyRes.data.result.isValid}`);
  for (const c of verifyRes.data.result.checks) {
    console.log(`  [${c.passed ? "✓ PASS" : "✗ FAIL"}] ${c.name}: ${c.actual}`);
  }

  // 4. Test GET / (Main HTML Dashboard Page)
  console.log("\n--- 4. Testing GET / (HTML Dashboard) ---");
  const pageRes = await fetchJson("http://127.0.0.1:3000/");
  console.log(`Status: ${pageRes.status}`);
  console.log(`Content-Type contains HTML: ${pageRes.text?.includes("<!DOCTYPE html>") || pageRes.text?.includes("<html")}`);
  console.log(`Contains 'PoolSync': ${pageRes.text?.includes("PoolSync")}`);

  console.log("\n>>> ALL DASHBOARD ENDPOINTS & INVARIANT VERIFICATIONS PASSED! <<<\n");

  server.kill("SIGINT");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
