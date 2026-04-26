const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(command, cwd) {
    console.log(`\n🚀 Running: ${command} in ${cwd || './'}`);
    try {
        execSync(command, { stdio: 'inherit', cwd });
    } catch (err) {
        console.error(`❌ Command failed: ${command}`);
        process.exit(1);
    }
}

console.log('📦 Starting Wallet Token Tracker Setup...');

// 1. Root
run('npm install');

// 2. Backend
const backendDir = path.join(__dirname, 'backend');
run('npm install', backendDir);
if (!fs.existsSync(path.join(backendDir, '.env'))) {
    console.log('📄 Creating backend/.env from example...');
    fs.copyFileSync(path.join(backendDir, '.env.example'), path.join(backendDir, '.env'));
}

// 3. Frontend
const frontendDir = path.join(__dirname, 'frontend');
run('npm install', frontendDir);

console.log('\n✅ Setup complete!');
console.log('📝 NEXT STEPS:');
console.log('1. Open backend/.env and verify your RPC_URL');
console.log('2. Run "npm run dev" to start the application');
