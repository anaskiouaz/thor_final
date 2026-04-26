# Wallet Token Tracker 🚀

A real-time monitoring application to detect when specific crypto wallets deploy new token contracts. Built for fullstack performance and accessibility via Tailscale.

## 🌟 Features
- **Real-time Monitoring**: Automatically detects contract deployments (Token creations) from watched addresses.
- **Multi-wallet Support**: Manage a list of wallets to track with custom labels.
- **Tailscale Optimized**: Backend and Frontend are configured to listen on `0.0.0.0`, making the dashboard accessible across your Tailscale network via your machine's private IP.
- **Persistent Storage**: Uses SQLite to keep track of your wallets and detection history.

## 🛠️ Tech Stack
- **Frontend**: React + Vite + Tailwind CSS + Lucide Icons
- **Backend**: Node.js + Express + Ethers.js
- **Database**: SQLite3

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (v18+)
- A Blockchain RPC URL (e.g., [Alchemy](https://www.alchemy.com/), [QuickNode](https://www.quicknode.com/), or public nodes like `https://mainnet.base.org`)

### 2. Installation
Run the setup script or install manually:

```bash
# Using the setup script (Linux/macOS/Git Bash)
chmod +x setup.sh
./setup.sh

# OR Manual Installation
npm install
cd backend && npm install
cp .env.example .env
cd ../frontend && npm install
```

### 3. Configuration
Edit `backend/.env` and provide your RPC URL:
```env
RPC_URL=https://mainnet.base.org  # Default is Base Mainnet
PORT=3000
```

### 4. Running the App
Start both frontend and backend simultaneously from the root directory:
```bash
npm run dev
```

## 🌐 Accessing via Tailscale

To access the tracker from another device (phone, laptop) in your Tailscale network:

1.  Ensure **Tailscale** is running on both the host machine and the remote device.
2.  Find the **Tailscale IP** of the machine running the tracker (e.g., `100.x.y.z`).
3.  On your remote device, open your browser and navigate to:
    - **Frontend**: `http://100.x.y.z:5173`
    - The frontend is configured to automatically communicate with the backend on port `3000` via the same IP.

## 📄 License
ISC
