#!/bin/bash

# Wallet Token Tracker Setup Script

echo "🚀 Starting setup for Wallet Token Tracker..."

# Install Root dependencies
echo "📦 Installing root dependencies..."
npm install

# Install Backend dependencies
echo "📦 Installing backend dependencies..."
cd backend
npm install
cp .env.example .env
cd ..

# Install Frontend dependencies
echo "📦 Installing frontend dependencies..."
cd frontend
npm install
cd ..

echo "✅ Setup complete!"
echo "📝 NEXT STEPS:"
echo "1. Open backend/.env and add your RPC_URL (e.g., from Alchemy or QuickNode)"
echo "2. Run 'npm run dev' to start both frontend and backend"
echo "3. Access the dashboard at http://localhost:5173 or your Tailscale IP"
