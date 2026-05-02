const axios = require('axios');

async function testToken(name, mint) {
    console.log(`\n--- Testing ${name} (${mint}) ---`);
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/ohlcv/hour?aggregate=1&currency=usd&limit=1000`;
    
    try {
        const { data } = await axios.get(url, { 
            headers: { 
                'Accept': 'application/json;version=20230203',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000 
        });

        const candles = data?.data?.attributes?.ohlcv_list || [];
        if (candles.length > 0) {
            const oldest = candles[candles.length - 1];
            const latest = candles[0];
            const launch = Number(oldest[1]);
            const ath = Math.max(...candles.map(c => Number(c[2])));
            
            console.log(`✅ Success: Found ${candles.length} candles`);
            console.log(`🚀 Launch Price: $${launch.toFixed(10)}`);
            console.log(`🔝 ATH Price: $${ath.toFixed(10)}`);
            console.log(`📈 Peak Multiplier: x${(ath / launch).toFixed(2)}`);
        } else {
            console.log(`❌ No candles found on GeckoTerminal`);
        }
    } catch (err) {
        console.log(`❌ Error: ${err.message}`);
        if (err.response) console.log(`   Status: ${err.response.status}`);
    }
}

async function run() {
    // dogwifhat (WIF) - Known winner
    await testToken('WIF', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65pump');
    
    // Random recent pump token from your log
    await testToken('NICETRUMP', 'L7hEA1XV6MKa61cXrhcJHHAccLz35AUM6qcXYPTpump');
}

run();
