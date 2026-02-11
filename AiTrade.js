const { Anthropic } = require('@anthropic-ai/sdk');
const { ClobClient, ChainId } = require('@polymarket/clob-client');
const ethers = require('ethers');
const axios = require('axios');
require('dotenv').config();

// Konfigurasi Dasar
const DRY_RUN = true; 
const MIN_EDGE = 0.08; 
const MAX_CAPITAL_PER_TRADE = 0.06; 

/**
 * Fungsi Validasi Environment Variables
 * Membersihkan spasi dan memastikan URL valid
 */
function validateAndCleanEnv() {
    const requiredEnv = [
        'ANTHROPIC_API_KEY',
        'TAVILY_API_KEY',
        'POLYGON_PRIVATE_KEY',
        'POLYGON_RPC_URL'
    ];

    requiredEnv.forEach(env => {
        if (!process.env[env]) {
            console.error(`ERROR: [${env}] tidak ditemukan di .env!`);
            process.exit(1);
        }
        // Bersihkan spasi atau tanda kutip yang tidak sengaja terbawa
        process.env[env] = process.env[env].trim().replace(/['"]/g, '');
    });

    // Validasi format URL sederhana
    try {
        new URL(process.env.POLYGON_RPC_URL);
        if (process.env.ANTHROPIC_BASE_URL) {
            process.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL.trim().replace(/['"]/g, '');
            new URL(process.env.ANTHROPIC_BASE_URL);
        }
    } catch (e) {
        console.error(`ERROR: Format URL pada POLYGON_RPC_URL atau ANTHROPIC_BASE_URL tidak valid!`);
        console.error(`Pastikan diawali dengan https:// dan tidak ada spasi.`);
        process.exit(1);
    }
}

validateAndCleanEnv();

/**
 * Inisialisasi API Claude
 */
const anthropic = new Anthropic({ 
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined 
});

// Inisialisasi Provider dengan Error Handling
let provider;
try {
    provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
} catch (e) {
    console.error("Gagal inisialisasi RPC Provider. Cek POLYGON_RPC_URL di .env");
    process.exit(1);
}

const wallet = new ethers.Wallet(process.env.POLYGON_PRIVATE_KEY, provider);

async function performResearch(query) {
    try {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: process.env.TAVILY_API_KEY,
            query: query,
            search_depth: "advanced",
            max_results: 5
        });
        return response.data.results.map(r => r.content).join("\n---\n");
    } catch (e) {
        console.error("Gagal melakukan riset (Tavily):", e.message);
        return "Tidak ada data riset tambahan.";
    }
}

async function runCycle() {
    console.log(`[${new Date().toISOString()}] Memulai siklus riset...`);

    try {
        const marketName = "Pertandingan Bola / Isu Politik X";
        const currentMarketPrice = 0.52; 
        
        const researchData = await performResearch(`Berita terbaru tentang ${marketName}`);

        const prompt = `
        Anda adalah Agen Perdagangan Otonom.
        DATA PASAR: ${marketName} | Harga: ${currentMarketPrice * 100}%
        DATA RISET: ${researchData}
        
        Tugas: Berikan Nilai Wajar (0.0-1.0). Jika selisih > ${MIN_EDGE} dari harga pasar, BUY.
        Format JSON: { "fair_value": 0.7, "action": "BUY", "reasoning": "..." }`;

        // Anthropic Call
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1000,
            messages: [{ role: "user", content: prompt }]
        });

        const content = response.content[0].text;
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}') + 1;
        const jsonString = content.slice(jsonStart, jsonEnd);

        const decision = JSON.parse(jsonString);
        console.log("Keputusan AI:", decision);

        if (decision.action === "BUY" && (decision.fair_value - currentMarketPrice) >= MIN_EDGE) {
            console.log("Sinyal Beli Terdeteksi.");
        }

    } catch (err) {
        // Logging error lebih detail untuk debugging
        if (err.message.includes('Invalid URL')) {
            console.error("CRITICAL: Ada URL yang salah format. Cek ANTHROPIC_BASE_URL.");
        }
        console.error("Siklus gagal:", err.message);
    }
}

setInterval(runCycle, 10 * 60 * 1000);
runCycle();
