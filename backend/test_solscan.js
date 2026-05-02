require('dotenv').config();
const axios = require('axios');

async function testSolscan() {
    const url = 'https://pro-api.solscan.io/v2.0/token/meta?mint=L7hEA1XV6MKa61cXrhcJHHAccLz35AUM6qcXYPTpump';

    const keys = {
        'SOLANA_PRIVATE_KEY (JWT)': process.env.SOLANA_PRIVATE_KEY,
        'SOLSCAN_API_KEY': process.env.SOLSCAN_API_KEY
    };

    for (const [name, key] of Object.entries(keys)) {
        console.log(`\n--- Testing ${name} ---`);
        console.log('Key starts with:', key ? key.substring(0, 10) + '...' : 'undefined');

        // Test Authorization: Bearer
        try {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${key}` }
            });
            console.log('Auth Bearer -> Status:', response.status);
            console.log('Auth Bearer -> Data:', JSON.stringify(response.data).substring(0, 100));
        } catch (error) {
            console.log('Auth Bearer -> Status:', error.response ? error.response.status : 'Error', error.response ? error.response.data : error.message);
        }

        // Test token header
        try {
            const response = await axios.get(url, {
                headers: { 'token': key }
            });
            console.log('Token Header -> Status:', response.status);
            console.log('Token Header -> Data:', JSON.stringify(response.data).substring(0, 100));
        } catch (error) {
            console.log('Token Header -> Status:', error.response ? error.response.status : 'Error', error.response ? error.response.data : error.message);
        }
    }
}

testSolscan();
