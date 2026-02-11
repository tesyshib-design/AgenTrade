const { Anthropic } = require('@anthropic-ai/sdk');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const ethers = require('ethers');
const axios = require('axios');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const readline = require('readline'); // Tambahan untuk input terminal
require('dotenv').config({ override: true });

/**
 * 💀 PROJECT: OPEN-CLAW REPLICA (REAL MONEY MANAGEMENT)
 * Fitur: Interactive Menu, Real-time Balance Check, Dynamic Kelly Sizing
 */

const CONFIG = {
    AGENT_NAME: "OpenClaw-Node-Live",
    LIVE_TRADING_ENABLED: false, // Default FALSE, akan diubah via Menu
    
    // --- MANAJEMEN RISIKO DINAMIS ---
    USE_KELLY_CRITERION: true,
    KELLY_FRACTION: 0.20,       // 20% dari saran Kelly (Konservatif)
    MAX_CAPITAL_PERCENT: 0.10,  // Maksimal 10% dari saldo per posisi (Safety)
    MIN_EDGE: 0.08,             
    
    SCAN_INTERVAL: 10 * 60 * 1000, 
    API_COST_PER_CALL: 0.01, 
    SOURCES: {
        POLYMARKET: "https://clob.polymarket.com",
        TAVILY: "https://api.tavily.com/search",
        // Alamat Kontrak USDC (Bridged) di Polygon
        USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" 
    }
};

// --- STATE MANAGEMENT ---
const STATE = {
    balance: 0.00, 
    positions: [], 
    netProfit: 0.00,
    apiCostPaid: 0.00,
    logs: [],
    mode: 'PENDING' // Status untuk dashboard
};

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
io.on('connection', (socket) => socket.emit('init_state', STATE));

// --- LOGGER ---
const LOG = {
    send: (type, msg) => {
        const entry = { time: new Date().toLocaleTimeString(), type, msg };
        STATE.logs.push(entry);
        if (STATE.logs.length > 50) STATE.logs.shift();
        io.emit('new_log', entry);
        const color = type === 'DANGER' ? '\x1b[31m' : (type === 'SUCCESS' ? '\x1b[32m' : '\x1b[36m');
        console.log(`${color}[${type}]\x1b[0m ${msg}`);
    }
};

// --- VALIDASI & INIT ---
['ANTHROPIC_API_KEY', 'TAVILY_API_KEY', 'POLYGON_PRIVATE_KEY', 'POLYGON_RPC_URL'].forEach(k => {
    if (!process.env[k]) { console.error(`Missing ENV: ${k}`); process.exit(1); }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let provider, wallet, usdcContract;

// Minimal ABI untuk cek saldo USDC
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

try {
    const JsonRpcProvider = ethers.JsonRpcProvider || (ethers.providers ? ethers.providers.JsonRpcProvider : null);
    const WalletClass = ethers.Wallet || (ethers.providers ? ethers.providers.Wallet : null);
    const ContractClass = ethers.Contract || (ethers.Contract);

    if (!JsonRpcProvider) throw new Error("Ethers provider not found");

    provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL);
    wallet = new WalletClass(process.env.POLYGON_PRIVATE_KEY, provider);
    
    // Inisialisasi Kontrak USDC untuk Cek Saldo
    usdcContract = new ContractClass(CONFIG.SOURCES.USDC_ADDRESS, ERC20_ABI, provider);
    
    // LOG.send("SYSTEM", "Wallet & RPC Connected."); // Dipindahkan ke startBot
} catch (error) {
    console.error(`Init Error: ${error.message}`);
    process.exit(1);
}

const client = new ClobClient(CONFIG.SOURCES.POLYMARKET, 137, wallet);

// --- MODUL FINANSIAL ---

/** Cek Saldo USDC Real-time di Blockchain */
async function getLiveBalance() {
    try {
        const rawBalance = await usdcContract.balanceOf(wallet.address);
        // USDC memiliki 6 desimal
        const formatted = ethers.formatUnits ? ethers.formatUnits(rawBalance, 6) : ethers.utils.formatUnits(rawBalance, 6);
        return parseFloat(formatted);
    } catch (e) {
        LOG.send("WARN", `Gagal cek saldo on-chain: ${e.message}. Menggunakan saldo cache $${STATE.balance}`);
        return STATE.balance || 0;
    }
}

// --- MODUL TRADING ---

async function scanMarkets() {
    const reqConfig = {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 20000
    };

    try {
        let response = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/sampling-markets`, reqConfig);
        let markets = Array.isArray(response.data) ? response.data : (response.data.data || []);
        
        if (markets.length === 0) {
            response = await axios.get(`${CONFIG.SOURCES.POLYMARKET}/markets?active=true`, reqConfig);
            markets = Array.isArray(response.data) ? response.data : (response.data.data || []);
        }

        const filtered = markets.filter(m => {
            if (m.closed) return false;
            if (!m.tokens || !Array.isArray(m.tokens) || m.tokens.length < 2) return false;
            return true;
        });

        return filtered.slice(0, 10); 
    } catch (e) {
        LOG.send("DANGER", `Gagal Scan Pasar: ${e.message}`);
        return [];
    }
}

async function executeOrder(tokenID, side, price, sizeShares, sizeUSD) {
    if (!CONFIG.LIVE_TRADING_ENABLED) {
        LOG.send("SIMULASI", `Order ${side} $${sizeUSD.toFixed(2)} (${sizeShares.toFixed(1)} Lembar) @ ${price}`);
        return;
    }

    try {
        LOG.send("EKSEKUSI", `Mengirim Order: ${side} $${sizeUSD.toFixed(2)} (${sizeShares.toFixed(1)} Lembar)...`);
        
        const order = await client.createOrder({
            tokenID: tokenID,
            price: price,
            side: side === 'BUY' ? Side.BUY : Side.SELL,
            size: sizeShares, // Polymarket API butuh jumlah lembar, bukan dolar
            feeRateBps: 0,
            nonce: Date.now() 
        });

        // Cek response sukses
        if (order && order.orderID) {
            LOG.send("SUCCESS", `Order Sukses! ID: ${order.orderID}`);
            STATE.positions.push({ id: order.orderID, size: sizeUSD, time: Date.now() });
        } else {
            LOG.send("WARN", `Order Terkirim tapi ID tidak kembali. Cek Polymarket.`);
        }
    } catch (e) {
        LOG.send("ERROR", `Gagal Eksekusi: ${e.message}`);
        if (e.message.includes('allowance') || e.message.includes('funds')) {
            LOG.send("DANGER", "Saldo tidak cukup atau USDC belum di-approve! Lakukan transaksi manual sekali di web untuk approve.");
        }
    }
}

async function analyzeAndTrade() {
    // 1. Update Saldo Real-time
    const currentBalance = await getLiveBalance();
    STATE.balance = currentBalance;
    STATE.apiCostPaid += CONFIG.API_COST_PER_CALL;
    
    // Safety check: Jangan trade jika saldo kritis
    if (currentBalance < 2.0 && CONFIG.LIVE_TRADING_ENABLED) {
        LOG.send("DANGER", `Saldo Kritis ($${currentBalance.toFixed(2)}). Menunggu topup...`);
        io.emit('update_stats', STATE);
        return;
    }

    io.emit('update_stats', STATE);

    const markets = await scanMarkets();
    
    if (markets.length === 0) {
        LOG.send("SCANNER", "Tidak ada pasar aktif.");
        return;
    }

    LOG.send("SCANNER", `Memindai ${markets.length} pasar (Saldo: $${currentBalance.toFixed(2)})...`);

    for (const m of markets) {
        const price = parseFloat(m.tokens[0].price);
        if (price < 0.05 || price > 0.95) continue; 

        // Riset Tavily
        let researchData = "";
        try {
            const tavilyRes = await axios.post(CONFIG.SOURCES.TAVILY, {
                api_key: process.env.TAVILY_API_KEY,
                query: `Prediction analysis: ${m.question}`,
                max_results: 1
            });
            researchData = tavilyRes.data.results.map(r => r.content).join("\n").substring(0, 1000);
        } catch (e) {}

        const prompt = `Pasar: "${m.question}". Harga YES: ${price}. Riset: ${researchData}. Jawab JSON {"fv": float, "reason": "string"}`;
        
        try {
            const msg = await anthropic.messages.create({
                model: "claude-3-haiku-20240307",
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }]
            });
            
            const jsonMatch = msg.content[0].text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON found");
            
            const analysis = JSON.parse(jsonMatch[0]);
            const edge = analysis.fv - price;
            const absEdge = Math.abs(edge);
            
            LOG.send("AI", `"${m.question.substr(0,15)}..." Fair: ${analysis.fv.toFixed(2)} Edge: ${(edge*100).toFixed(1)}%`);

            if (absEdge > CONFIG.MIN_EDGE) {
                let targetTokenID, sideName;
                if (edge > 0) {
                    targetTokenID = m.tokens[0].token_id; 
                    sideName = "BUY YES";
                } else {
                    targetTokenID = m.tokens[1].token_id; 
                    sideName = "BUY NO";
                }

                // --- MANAJEMEN RISIKO: UKURAN POSISI (DYNAMIC) ---
                // Hitung modal maksimal berdasarkan saldo SAAT INI
                const maxTradeAmount = currentBalance * CONFIG.MAX_CAPITAL_PERCENT; // Max 10% saldo
                
                // Rumus Kelly Sederhana
                let sizeUSD = currentBalance * CONFIG.KELLY_FRACTION * absEdge; 
                
                // Capping (Safety)
                if (sizeUSD > maxTradeAmount) sizeUSD = maxTradeAmount;
                if (sizeUSD < 1) sizeUSD = 1.0; // Minimal $1 untuk masuk

                // Cek apakah saldo cukup
                if (currentBalance < sizeUSD) {
                    LOG.send("WARN", `Saldo tidak cukup untuk trade $${sizeUSD.toFixed(2)}`);
                    continue;
                }

                // Konversi USD ke Lembar Saham (Shares)
                // Di Polymarket: Jumlah Lembar = Uang / Harga
                const quantityShares = sizeUSD / price;

                LOG.send("SINYAL", `>>> ${sideName} $${sizeUSD.toFixed(2)} (${quantityShares.toFixed(1)} Lembar)`);
                
                await executeOrder(targetTokenID, 'BUY', price, quantityShares, sizeUSD);
            }

        } catch (e) {
            // LOG.send("WARN", `Gagal analisa: ${e.message}`);
        }
    }
}

// --- FUNGSI MENU UTAMA ---
function startBot() {
    server.listen(PORT, () => {
        const modeText = CONFIG.LIVE_TRADING_ENABLED ? "LIVE TRADING (UANG ASLI)" : "DRY RUN (SIMULASI)";
        const color = CONFIG.LIVE_TRADING_ENABLED ? "\x1b[31m" : "\x1b[36m";
        
        console.log(`\n===================================================`);
        console.log(`🚀 OPENCLAW LIVE DI PORT ${PORT}`);
        console.log(`👉 MODE OPERASIONAL: ${color}${modeText}\x1b[0m`);
        console.log(`👉 AKSES DASHBOARD: http://43.167.197.60:${PORT}`);
        console.log(`===================================================\n`);
        
        LOG.send("SYSTEM", `Bot dimulai dalam mode: ${modeText}`);
        analyzeAndTrade();
        setInterval(analyzeAndTrade, CONFIG.SCAN_INTERVAL);
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function showMenu() {
    console.clear();
    console.log(`
    \x1b[36m
    =========================================
    💀 OPEN-CLAW TRADING AGENT v1.0
    =========================================
    \x1b[0m
    Pilih Mode Operasional:
    
    [1] 🛡️  DRY RUN (Simulasi - Saldo Aman)
        -> Bot hanya akan mencatat sinyal, tidak ada uang keluar.
        
    [2] 💸 LIVE TRADING (Resiko Tinggi - Uang Asli)
        -> Bot akan mengeksekusi order di Polymarket.
        -> Pastikan saldo USDC tersedia dan sudah di-Approve.
    `);

    rl.question('Masukkan pilihan (1 atau 2): ', (answer) => {
        if (answer === '1') {
            CONFIG.LIVE_TRADING_ENABLED = false;
            STATE.mode = 'DRY RUN';
            console.log('\n✅ Memilih Mode SIMULASI.');
            rl.close();
            startBot();
        } else if (answer === '2') {
            console.log('\n⚠️  PERINGATAN: ANDA MEMILIH MENGGUNAKAN UANG ASLI.');
            rl.question('Ketik "CONFIRM" untuk melanjutkan: ', (confirm) => {
                if (confirm === 'CONFIRM') {
                    CONFIG.LIVE_TRADING_ENABLED = true;
                    STATE.mode = 'LIVE TRADING';
                    console.log('\n🚀 Memilih Mode LIVE TRADING.');
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

// Mulai Aplikasi dengan Menu
showMenu();
