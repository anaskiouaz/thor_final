# Thor V2 - Advanced Solana Sniper & Trading Bot 🚀

Thor V2 is a high-speed automated Solana trading bot featuring direct Pump.fun and Raydium/Jupiter interactions, real-time token sniping, and a robust auto-sell engine (TP/SL).

## 🌟 Features
- **Real-time Sniping:** Subscribes to Helius WebSockets for lightning-fast token detection and sniping.
- **Auto-Sell Engine:** Tracks Take Profit (TP), Stop Loss (SL), and All-Time Highs (ATH) to secure profits.
- **Pump.fun Integration:** Native integration for bonding curve transactions.
- **Jupiter & Raydium Routing:** Advanced routing for accurate token swaps and pricing.
- **Telegram Notifications:** Get real-time alerts on your phone for executed trades and performance.
- **Dashboard:** React/Tailwind frontend for monitoring and managing bot settings.

## 🛠️ System Requirements
- **Node.js**: v18 or higher
- **Solana Wallet**: A wallet funded with SOL (for gas and buying tokens)

## 🔑 API Keys & Configuration Requirements

To run Thor V2, you need several keys and endpoints. Copy the `backend/.env.example` file to `backend/.env` and fill in the following details:

### 1. Helius API Key (Critical)
Helius provides the high-speed RPC and WebSocket connections necessary for Solana sniping.
- **Where to get it:** Go to [Helius.dev](https://dev.helius.xyz/) and create an account.
- **How to find it:** Navigate to your dashboard -> API Keys.
- **Usage in `.env`**:
  - `HELIUS_API_KEY=your_api_key`
  - `RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
  - `WSS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
  - `HELIUS_TRANSACTIONS_URL=https://api-mainnet.helius-rpc.com/v0/transactions/?api-key=YOUR_KEY`
> *Note: You can add a backup key (`HELIUS_API_KEY1`, etc.) in the `.env` to avoid rate limits during high volatility.*

### 2. Solana Wallet Private Key (Base58)
The bot needs access to a wallet to sign and execute trades on your behalf.
- **Where to get it:** Your Solana wallet (e.g., Phantom, Solflare).
- **How to find it (Phantom):** Open Phantom -> Settings (⚙️) -> Manage Accounts -> Select Account -> "Show Private Key".
- **Usage in `.env`**:
  - `SOLANA_PRIVATE_KEY=your_base58_private_key_here`
> ⚠️ **SECURITY WARNING:** NEVER share this private key with anyone and NEVER commit your `.env` file to GitHub.

### 3. Telegram Bot Token & Chat ID (Optional but Recommended)
Used to receive notifications when the bot buys or sells a token.
- **Where to get it:** Telegram.
- **How to find the Bot Token:**
  1. Message `@BotFather` on Telegram.
  2. Send `/newbot` and follow the setup instructions.
  3. Copy the HTTP API token provided.
- **How to find your Chat ID:**
  1. Start a chat with your newly created bot.
  2. Message `@userinfobot` or `@RawDataBot` on Telegram to get your personal `chat_id`.
- **Usage in `.env`**:
  - `TELEGRAM_BOT_TOKEN=your_bot_token`
  - `TELEGRAM_CHAT_ID=your_chat_id`

### 4. Solscan API Key (Optional)
Used for advanced blockchain data tracking and parsing.
- **Where to get it:** [Solscan Public API](https://public-api.solscan.io/).
- **How to find it:** Create an account and generate an API key in your account settings.
- **Usage in `.env`**:
  - `SOLSCAN_API_KEY=your_solscan_api_key`

## 🚀 Installation & Setup

1. **Clone/Download the repository**
2. **Install Backend Dependencies:**
   ```bash
   cd backend
   npm install
   ```
3. **Configure Environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys (see requirements above)
   ```
4. **Install Frontend Dependencies:**
   ```bash
   cd ../frontend
   npm install
   ```
5. **Run the Application:**
   From the root folder, you can run the dev servers:
   ```bash
   # Terminal 1 (Backend)
   cd backend && npm run dev
   
   # Terminal 2 (Frontend)
   cd frontend && npm run dev
   ```

## ⚠️ Disclaimer
Trading cryptocurrencies, especially sniping memecoins on Solana, involves significant financial risk. This bot is provided "as is" with no guarantees of profitability. Never trade with money you cannot afford to lose. Always test with small amounts first or use the `DRY_RUN=true` mode if available!
