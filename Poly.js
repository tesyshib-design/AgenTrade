const { Anthropic } = require('@anthropic-ai/sdk');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const ethers = require('ethers');
const axios = require('axios');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const readline = require('readline');
require('dotenv').config({ override: true });

/**
 * 💀 PROJECT: OPEN-CLAW REPLICA — SURVIVAL MODE
 * Fitur: Batch AI Analysis, Adaptive Sizing, Win Rate Tracking, $50 Modal
 * Inspirasi: OpenClaw Agent ($50 → $2.9K dalam 48 jam)
 */

const CONFIG = {
    AGENT_NAME: "OpenClaw-Survival",
    LIVE_TRADING_ENABLED: false,

    // --- MODAL AWAL ---
    INITIAL_BALANCE: 50,

    // --- SCANNING ---
    SCAN_INTERVAL: 9 * 60 * 1000,   // 9 menit per cycle (312 cycles/48 jam)
    MAX_MARKETS: 50,                  // Scan hingga 50 market
    BATCH_SIZE: 5,                    // 5 market per AI call (hemat biaya!)

    // --- MANAJEMEN RISIKO ADAPTIF (SURVIVAL MODE) ---
    KELLY_FRACTION: 0.25,
    MIN_EDGE: 0.06,                   // Threshold edge lebih rendah = lebih banyak peluang

    // Tier berdasarkan saldo (adaptive sizing)
    TIERS: {
        MICRO: { maxBalance: 20, maxPercent: 0.08, minTrade: 1.0 },  // < $20: konservatif
        SMALL: { maxBalance: 100, maxPercent: 0.15, minTrade: 1.0 },  // $20-100: normal
        MEDIUM: { maxBalance: 500, maxPercent: 0.20, minTrade: 2.0 },  // $100-500: agresif
        LARGE: { maxBalance: Infinity, maxPercent: 0.20, minTrade: 5.0 } // > $500: scale up
    },

    // --- API ---
    API_DELAY_MS: 500,                // Delay antar batch (bukan per market)
    API_COST_PER_CALL: 0.001,         // ~$0.001 per Haiku call
    SOURCES: {
        POLYMARKET: "https://clob.polymarket.com",
        TAVILY: "https://api.tavily.com/search",
        USDC_ADDRESS: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" // Native USDC Polygon
    }
};

// --- STATE MANAGEMENT ---
const STATE = {
    balance: 0.00,
    initialBalance: CONFIG.INITIAL_BALANCE,
    positions: [],
    resolvedTrades: [],
    wins: 0,
    losses: 0,
    winRate: 0,
    netProfit: 0.00,
    apiCostPaid: 0.00,
    cycleCount: 0,
    logs: [],
    mode: 'PENDING',
    startTime: null
};

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
io.on('connection', (socket) => socket.emit('init_state', STATE));

// --- LOGGER ---
const LOG = {
    send: (type, msg) => {
        const entry = { time: new Date().toLocaleTimeString(), type, msg };
        STATE.logs.push(entry);
        if (STATE.logs.length > 100) STATE.logs.shift();
        io.emit('new_log', entry);
        const colors = {
            DANGER: '\x1b[31m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m',
            SINYAL: '\x1b[35m', AI: '\x1b[36m', SCANNER: '\x1b[36m',
            SYSTEM: '\x1b[37m', SIMULASI: '\x1b[34m', EKSEKUSI: '\x1b[31m',
        };
        const color = colors[type] || '\x1b[36m';
        console.log(`${color}[${type}]\x1b[0m ${msg}`);
    }
};

// --- VALIDASI & INIT ---
['ANTHROPIC_API_KEY', 'TAVILY_API_KEY', 'POLYGON_PRIVATE_KEY', 'POLYGON_RPC_URL'].forEach(k => {
    if (!process.env[k]) { console.error(`Missing ENV: ${k}`); process.exit(1); }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let provider, wallet, usdcContract;

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

try {
    const JsonRpcProvider = ethers.JsonRpcProvider || (ethers.providers ? ethers.providers.JsonRpcProvider : null);
    const WalletClass = ethers.Wallet || (ethers.providers ? ethers.providers.Wallet : null);
    const ContractClass = ethers.Contract;

    if (!JsonRpcProvider) throw new Error("Ethers provider not found");

    provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL);
    wallet = new WalletClass(process.env.POLYGON_PRIVATE_KEY, provider);
    usdcContract = new ContractClass(CONFIG.SOURCES.USDC_ADDRESS, ERC20_ABI, provider);
} catch (error) {
    console.error(`Init Error: ${error.message}`);
    process.exit(1);
}

const client = new ClobClient(CONFIG.SOURCES.POLYMARKET, 137, wallet);

// ============================================================
// MODUL FINANSIAL
// ============================================================

/** Cek Saldo USDC Real-time di Blockchain */
async function getLiveBalance() {
    try {
        const rawBalance = await usdcContract.balanceOf(wallet.address);
        const formatted = ethers.formatUnits ? ethers.formatUnits(rawBalance, 6) : ethers.utils.formatUnits(rawBalance, 6);
        return parseFloat(formatted);
    } catch (e) {
        LOG.send("WARN", `Gagal cek saldo on-chain: ${e.message}. Pakai cache $${STATE.balance}`);
        return STATE.balance || 0;
    }
}

/** Tentukan tier risiko berdasarkan saldo saat ini */
function getTier(balance) {
    if (balance < CONFIG.TIERS.MICRO.maxBalance) return CONFIG.TIERS.MICRO;
    if (balance < CONFIG.TIERS.SMALL.maxBalance) return CONFIG.TIERS.SMALL;
    if (balance < CONFIG.TIERS.MEDIUM.maxBalance) return CONFIG.TIERS.MEDIUM;
    return CONFIG.TIERS.LARGE;
}

/** Hitung ukuran posisi dengan Full Kelly + Adaptive Tier */
function calculatePositionSize(balance, fairValue, marketPrice) {
    const tier = getTier(balance);
    const maxTradeAmount = balance * tier.maxPercent;

    // Full Kelly Criterion: f* = (p*b - q) / b
    const prob = fairValue;
    const odds = (1 / marketPrice) - 1;
    const kellyFull = (prob * odds - (1 - prob)) / odds;
    let sizeUSD = balance * CONFIG.KELLY_FRACTION * Math.max(kellyFull, 0);

    // Capping berdasarkan tier
    if (sizeUSD > maxTradeAmount) sizeUSD = maxTradeAmount;
    if (sizeUSD < tier.minTrade) sizeUSD = tier.minTrade;

    // Jangan trade lebih dari saldo
    if (sizeUSD > balance * 0.90) sizeUSD = balance * 0.90;

    return { sizeUSD, tier };
}

// ============================================================
// MODUL SCANNER — Scan Banyak Market
// ============================================================

async function scanMarkets() {
    const reqConfig = {
        headers: { 'User-Agent': 'Mozilla/5.0 (OpenClaw-Agent/1.0)' },
        timeout: 25000
    };

    try {
        let allMarkets = [];

        // Endpoint 1: Sampling markets
        try {
            const resp1 = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/sampling-markets`, reqConfig);
            const m1 = Array.isArray(resp1.data) ? resp1.data : (resp1.data.data || []);
            allMarkets.push(...m1);
        } catch (e) { /* silent */ }

        // Endpoint 2: Active markets (lebih banyak)
        try {
            const resp2 = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/markets?active=true&limit=100`, reqConfig);
            const m2 = Array.isArray(resp2.data) ? resp2.data : (resp2.data.data || []);
            allMarkets.push(...m2);
        } catch (e) { /* silent */ }

        // Endpoint 3: Halaman kedua
        try {
            const resp3 = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/markets?active=true&limit=100&offset=100`, reqConfig);
            const m3 = Array.isArray(resp3.data) ? resp3.data : (resp3.data.data || []);
            allMarkets.push(...m3);
        } catch (e) { /* silent */ }

        // Deduplicate berdasarkan question
        const seen = new Set();
        const unique = allMarkets.filter(m => {
            if (!m.question || seen.has(m.question)) return false;
            seen.add(m.question);
            return true;
        });

        // Filter: harus aktif, punya tokens, harga dalam range tradeable
        const filtered = unique.filter(m => {
            if (m.closed) return false;
            if (!m.tokens || !Array.isArray(m.tokens) || m.tokens.length < 2) return false;
            const price = parseFloat(m.tokens[0].price);
            if (isNaN(price) || price < 0.10 || price > 0.90) return false;
            return true;
        });

        LOG.send("SCANNER", `Scanning ${allMarkets.length} feeds → ${filtered.length} tradeable markets`);

        return filtered.slice(0, CONFIG.MAX_MARKETS);
    } catch (e) {
        LOG.send("DANGER", `Gagal Scan Pasar: ${e.message}`);
        return [];
    }
}

// ============================================================
// MODUL AI — Batch Analysis (5 market per call = HEMAT BIAYA)
// ============================================================

const SYSTEM_PROMPT = `You are a professional prediction market analyst. For each market, estimate the TRUE probability (fair value) that the event will resolve YES.

Analysis framework:
1. Base Rate: How often do similar events happen historically?
2. Evidence: What does current news/data suggest?
3. Timeline: When does this resolve? Nearer events have less uncertainty.
4. Market Efficiency: Is the market price already fair?

CRITICAL RULES:
- fair_value MUST be between 0.01 and 0.99
- confidence MUST be between 0.0 and 1.0
- Only give high confidence (>0.7) when you have strong evidence
- If uncertain, set confidence below 0.5

You MUST respond with ONLY a valid JSON array, no other text.`;

/** Batch analisis: kirim beberapa market sekaligus ke AI */
async function batchAnalyze(marketBatch, researchMap) {
    const marketDescriptions = marketBatch.map((m, i) => {
        const price = parseFloat(m.tokens[0].price).toFixed(2);
        const research = researchMap[m.question] || "No additional research available.";
        return `Market ${i + 1}: "${m.question}" | Current YES price: ${price} | Research: ${research}`;
    }).join('\n');

    const userPrompt = `Analyze these ${marketBatch.length} prediction markets and return a JSON array with one object per market:

${marketDescriptions}

Respond ONLY with JSON array format:
[{"market_index": 1, "fair_value": 0.XX, "confidence": 0.XX, "reason": "brief reason"}]`;

    try {
        const msg = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 800,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }]
        });

        STATE.apiCostPaid += CONFIG.API_COST_PER_CALL;

        let text = msg.content[0].text.trim();

        // Robust JSON extraction: cari array JSON
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array in response");

        // Sanitize: hapus trailing commas dan fix common issues
        let jsonStr = jsonMatch[0]
            .replace(/,\s*]/g, ']')      // trailing comma sebelum ]
            .replace(/,\s*}/g, '}')      // trailing comma sebelum }
            .replace(/\n/g, ' ')          // remove newlines dalam JSON
            .replace(/[\x00-\x1F]/g, '') // remove control chars
            .trim();

        let results;
        try {
            results = JSON.parse(jsonStr);
        } catch (parseErr) {
            // Fallback: coba parse individual objects
            const objMatches = jsonStr.match(/\{[^{}]+\}/g);
            if (!objMatches) throw parseErr;
            results = objMatches.map(o => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
        }

        // Validasi setiap hasil
        return results.filter(r => {
            if (typeof r.fair_value !== 'number') return false;
            if (r.fair_value < 0.01 || r.fair_value > 0.99) return false;
            if (typeof r.confidence !== 'number') return false;
            return true;
        });

    } catch (e) {
        LOG.send("WARN", `Batch AI gagal: ${e.message}`);
        return [];
    }
}

/** Riset Tavily — hanya untuk market yang menjanjikan (selective) */
async function getResearch(question) {
    try {
        const tavilyRes = await axios.post(CONFIG.SOURCES.TAVILY, {
            api_key: process.env.TAVILY_API_KEY,
            query: `Latest news prediction: ${question}`,
            max_results: 3
        }, { timeout: 10000 });
        return tavilyRes.data.results.map(r => r.content).join(" ").substring(0, 500);
    } catch (e) {
        return "";
    }
}

// ============================================================
// MODUL EKSEKUSI ORDER
// ============================================================

async function executeOrder(tokenID, side, price, sizeShares, sizeUSD, marketQuestion) {
    if (!CONFIG.LIVE_TRADING_ENABLED) {
        LOG.send("SIMULASI", `ORDER $${sizeUSD.toFixed(2)} → "${marketQuestion.substring(0, 30)}"`);
        // Simulasi: catat sebagai pending trade + kurangi saldo simulasi
        STATE.balance -= sizeUSD;
        STATE.positions.push({
            question: marketQuestion,
            side, price, sizeUSD,
            time: Date.now(),
            status: 'SIMULATED'
        });
        return;
    }

    try {
        LOG.send("EKSEKUSI", `ORDER $${sizeUSD.toFixed(2)} → "${marketQuestion.substring(0, 30)}"...`);

        const order = await client.createOrder({
            tokenID: tokenID,
            price: price,
            side: side === 'BUY' ? Side.BUY : Side.SELL,
            size: sizeShares,
            feeRateBps: 0,
            nonce: Date.now()
        });

        if (order && order.orderID) {
            LOG.send("SUCCESS", `Order Sukses! ID: ${order.orderID}`);
            STATE.positions.push({
                id: order.orderID,
                question: marketQuestion,
                side, price, sizeUSD,
                time: Date.now(),
                status: 'ACTIVE'
            });
        } else {
            LOG.send("WARN", `Order terkirim tapi ID tidak kembali. Cek Polymarket.`);
        }
    } catch (e) {
        LOG.send("ERROR", `Gagal Eksekusi: ${e.message}`);
        if (e.message.includes('allowance') || e.message.includes('funds')) {
            LOG.send("DANGER", "Saldo tidak cukup atau USDC belum di-approve!");
        }
    }
}

// ============================================================
// SIKLUS UTAMA — SURVIVAL MODE
// ============================================================

async function analyzeAndTrade() {
    STATE.cycleCount++;
    const cycleNum = STATE.cycleCount;

    // 1. Update Saldo
    let currentBalance;
    if (CONFIG.LIVE_TRADING_ENABLED) {
        // LIVE: Cek saldo on-chain
        currentBalance = await getLiveBalance();
    } else {
        // DRY RUN: Gunakan saldo simulasi
        if (STATE.balance <= 0) STATE.balance = CONFIG.INITIAL_BALANCE;
        currentBalance = STATE.balance;
    }
    STATE.balance = currentBalance;
    STATE.netProfit = currentBalance - STATE.initialBalance;

    // Hitung win rate
    const totalTrades = STATE.wins + STATE.losses;
    STATE.winRate = totalTrades > 0 ? ((STATE.wins / totalTrades) * 100).toFixed(1) : '0.0';

    // Safety check
    if (currentBalance < 1.0 && CONFIG.LIVE_TRADING_ENABLED) {
        LOG.send("DANGER", `Saldo Kritis ($${currentBalance.toFixed(2)}). Pause...`);
        io.emit('update_stats', STATE);
        return;
    }

    io.emit('update_stats', STATE);

    const tier = getTier(currentBalance);
    const tierName = currentBalance < 20 ? 'MICRO' : currentBalance < 100 ? 'SMALL' : currentBalance < 500 ? 'MEDIUM' : 'LARGE';

    LOG.send("SYSTEM", `═══ Cycle #${cycleNum} | Balance: $${currentBalance.toFixed(2)} | Tier: ${tierName} | WR: ${STATE.winRate}% (${STATE.wins}W/${STATE.losses}L) ═══`);

    // 2. Scan Markets
    const markets = await scanMarkets();
    if (markets.length === 0) {
        LOG.send("SCANNER", "Tidak ada pasar tradeable.");
        return;
    }

    // 3. Selective Research (hanya untuk batch pertama, hemat biaya Tavily)
    const researchMap = {};
    const researchTargets = markets.slice(0, 10); // Riset 10 market teratas saja
    LOG.send("AI", `Researching ${researchTargets.length} top markets...`);

    for (const m of researchTargets) {
        researchMap[m.question] = await getResearch(m.question);
        await new Promise(r => setTimeout(r, 200)); // Rate limit Tavily
    }

    // 4. Batch AI Analysis (5 market per call)
    let tradesExecuted = 0;

    for (let i = 0; i < markets.length; i += CONFIG.BATCH_SIZE) {
        const batch = markets.slice(i, i + CONFIG.BATCH_SIZE);

        LOG.send("AI", `Evaluating ${batch.length} markets (batch ${Math.floor(i / CONFIG.BATCH_SIZE) + 1})...`);

        const results = await batchAnalyze(batch, researchMap);

        for (const result of results) {
            const idx = (result.market_index || 1) - 1;
            if (idx < 0 || idx >= batch.length) continue;

            const market = batch[idx];
            const price = parseFloat(market.tokens[0].price);
            const fv = result.fair_value;
            const confidence = result.confidence || 0;
            const edge = fv - price;
            const absEdge = Math.abs(edge);

            // Filter: minimum edge DAN minimum confidence
            if (absEdge < CONFIG.MIN_EDGE) continue;
            if (confidence < 0.50) continue;

            LOG.send("AI", `Edge: "${market.question.substring(0, 35)}" @ ${price.toFixed(2)} (fair ${fv.toFixed(2)}, conf ${confidence.toFixed(2)})`);

            // Tentukan sisi trade
            let targetTokenID, sideName;
            if (edge > 0) {
                targetTokenID = market.tokens[0].token_id;
                sideName = "BUY YES";
            } else {
                targetTokenID = market.tokens[1].token_id;
                sideName = "BUY NO";
            }

            // Hitung ukuran posisi (adaptive)
            const { sizeUSD } = calculatePositionSize(currentBalance, fv, price);

            if (currentBalance < sizeUSD) {
                LOG.send("WARN", `Saldo tidak cukup ($${currentBalance.toFixed(2)}) untuk $${sizeUSD.toFixed(2)}`);
                continue;
            }

            const quantityShares = sizeUSD / price;

            LOG.send("SINYAL", `>>> ${sideName} $${sizeUSD.toFixed(2)} → "${market.question.substring(0, 30)}"`);
            await executeOrder(targetTokenID, 'BUY', price, quantityShares, sizeUSD, market.question);
            tradesExecuted++;
        }

        // Delay antar batch
        if (i + CONFIG.BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, CONFIG.API_DELAY_MS));
        }
    }

    // 5. Ringkasan Cycle
    const apiCostStr = STATE.apiCostPaid < 1 ? `$${STATE.apiCostPaid.toFixed(3)}` : `$${STATE.apiCostPaid.toFixed(2)}`;
    LOG.send("SYSTEM", `Cycle #${cycleNum} selesai. ${tradesExecuted} trades. API cost total: ${apiCostStr}`);
    io.emit('update_stats', STATE);
}

// ============================================================
// MODUL TRADE RESOLUTION (Win Rate Tracking)
// ============================================================

/** Simulasi resolusi trade — di live mode, cek market yang sudah resolved */
async function checkResolutions() {
    // Untuk setiap posisi aktif, cek apakah market sudah resolved
    const pendingPositions = STATE.positions.filter(p => p.status === 'ACTIVE' || p.status === 'SIMULATED');

    for (const pos of pendingPositions) {
        try {
            // Cek apakah market sudah closed
            const resp = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/markets`, {
                params: { question: pos.question },
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            const marketData = Array.isArray(resp.data) ? resp.data : (resp.data.data || []);
            const matched = marketData.find(m => m.question === pos.question);

            if (matched && matched.closed) {
                const resolvedPrice = parseFloat(matched.tokens[0].price);
                const isWin = (pos.side === 'BUY' && resolvedPrice > pos.price) ||
                    (resolvedPrice >= 0.90); // YES resolved

                const pnl = isWin ? pos.sizeUSD * ((1 / pos.price) - 1) : -pos.sizeUSD;

                if (isWin) {
                    STATE.wins++;
                    LOG.send("SUCCESS", `RESOLVED +$${pnl.toFixed(2)} → "${pos.question.substring(0, 30)}"`);
                } else {
                    STATE.losses++;
                    LOG.send("DANGER", `RESOLVED -$${Math.abs(pnl).toFixed(2)} → "${pos.question.substring(0, 30)}"`);
                }

                pos.status = 'RESOLVED';
                pos.pnl = pnl;
                STATE.resolvedTrades.push(pos);
            }
        } catch (e) {
            // Skip silently, coba lagi next cycle
        }
    }

    // Cleanup: hapus posisi resolved dari array aktif
    STATE.positions = STATE.positions.filter(p => p.status !== 'RESOLVED');
}

// ============================================================
// SCHEDULER & STARTUP
// ============================================================

let isRunning = false;

async function scheduledRun() {
    if (isRunning) {
        LOG.send("WARN", "Siklus sebelumnya masih berjalan, skip.");
        setTimeout(scheduledRun, CONFIG.SCAN_INTERVAL);
        return;
    }
    isRunning = true;
    try {
        await analyzeAndTrade();
        // Cek resolusi trade setiap cycle
        await checkResolutions();
    } catch (e) {
        LOG.send("DANGER", `Error siklus utama: ${e.message}`);
    } finally {
        isRunning = false;
    }
    setTimeout(scheduledRun, CONFIG.SCAN_INTERVAL);
}

function startBot() {
    STATE.startTime = Date.now();

    server.listen(PORT, HOST, () => {
        const modeText = CONFIG.LIVE_TRADING_ENABLED ? "⚡ LIVE TRADING (UANG ASLI)" : "🛡️ DRY RUN (SIMULASI)";
        const color = CONFIG.LIVE_TRADING_ENABLED ? "\x1b[31m" : "\x1b[36m";

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`💀 OPENCLAW SURVIVAL MODE — PORT ${PORT}`);
        console.log(`${color}👉 ${modeText}\x1b[0m`);
        console.log(`💰 Initial Balance: $${CONFIG.INITIAL_BALANCE}`);
        console.log(`📊 Scan: ${CONFIG.MAX_MARKETS} markets, ${CONFIG.BATCH_SIZE}/batch, every ${CONFIG.SCAN_INTERVAL / 60000}min`);
        console.log(`👉 Dashboard: http://${HOST}:${PORT}`);
        console.log(`${'═'.repeat(55)}\n`);

        LOG.send("SYSTEM", `Bot dimulai — ${modeText}`);
        LOG.send("SYSTEM", `Wallet: ${wallet.address}`);
        scheduledRun();
    });
}

// ============================================================
// MENU INTERAKTIF
// ============================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function showMenu() {
    console.clear();
    console.log(`
    \x1b[36m
    ╔═══════════════════════════════════════════╗
    ║    💀 OPENCLAW SURVIVAL MODE v2.0         ║
    ║    Batch AI • Adaptive Sizing • WR Track  ║
    ╚═══════════════════════════════════════════╝
    \x1b[0m
    Modal Awal: $${CONFIG.INITIAL_BALANCE}
    AI Model: Claude 3 Haiku (hemat ~$0.001/call)
    Batch: ${CONFIG.BATCH_SIZE} market/call, Max ${CONFIG.MAX_MARKETS} market/cycle

    Pilih Mode Operasional:

    [1] 🛡️  DRY RUN (Simulasi — Saldo Aman)
        → Bot mencatat sinyal tanpa eksekusi order.
        → Gunakan untuk validasi strategi.

    [2] 💸 LIVE TRADING (Resiko Tinggi — Uang Asli)
        → Bot mengeksekusi order di Polymarket.
        → Pastikan USDC tersedia dan sudah di-Approve.
    `);

    rl.question('Masukkan pilihan (1 atau 2): ', (answer) => {
        if (answer === '1') {
            CONFIG.LIVE_TRADING_ENABLED = false;
            STATE.mode = 'SURVIVAL - DRY RUN';
            console.log('\n✅ Mode SIMULASI aktif. Tidak ada uang keluar.');
            rl.close();
            startBot();
        } else if (answer === '2') {
            console.log('\n⚠️  PERINGATAN: ANDA MEMILIH MENGGUNAKAN UANG ASLI.');
            console.log(`    Modal: $${CONFIG.INITIAL_BALANCE}`);
            rl.question('Ketik "CONFIRM" untuk melanjutkan: ', (confirm) => {
                if (confirm === 'CONFIRM') {
                    CONFIG.LIVE_TRADING_ENABLED = true;
                    STATE.mode = 'SURVIVAL - LIVE';
                    console.log('\n🚀 Mode LIVE TRADING aktif. Hati-hati!');
                    rl.close();
                    startBot();
                } else {
                    console.log('\n❌ Konfirmasi salah. Kembali ke menu.');
                    setTimeout(showMenu, 1000);
                }
            });
        } else {
            console.log('\n❌ Pilihan tidak valid.');
            setTimeout(showMenu, 1000);
        }
    });
}

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
    LOG.send("SYSTEM", "Shutdown... Menutup koneksi.");
    const totalTrades = STATE.wins + STATE.losses;
    if (totalTrades > 0) {
        LOG.send("SYSTEM", `Final Stats: ${STATE.wins}W/${STATE.losses}L (${STATE.winRate}%), P&L: $${STATE.netProfit.toFixed(2)}, API: $${STATE.apiCostPaid.toFixed(3)}`);
    }
    server.close();
    rl.close();
    console.log('\n👋 Bot dihentikan dengan aman.');
    process.exit(0);
});

process.on('SIGTERM', () => {
    server.close();
    rl.close();
    process.exit(0);
});

// Mulai Aplikasi
showMenu();
