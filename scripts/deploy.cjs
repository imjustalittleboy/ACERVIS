// ACERVIS: Polygon Amoy Deployment Script
// Usage: node scripts/deploy.cjs
// Prerequisites: Set env vars or create .env file:
//   PRIVATE_KEY=your_wallet_private_key
//   ALCHEMY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/your-key
// Optional (for auto-authorization):
//   SUPER_ADMIN_SECRET=your_super_admin_secret
//   TEST_INSTITUTION_NAME="Test University"
//   TEST_INSTITUTION_CODE=TEST
//   TEST_INSTITUTION_QUOTA=1000

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.ALCHEMY_RPC_URL || process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('\n❌ Missing required environment variables:');
  console.error('   ALCHEMY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/your-key');
  console.error('   PRIVATE_KEY=your_wallet_private_key');
  process.exit(1);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log('\n═══════════════════════════════════════════');
  console.log('   ACERVIS — Polygon Amoy Deployment');
  console.log('═══════════════════════════════════════════\n');
  console.log(`  Deployer:    ${wallet.address}`);
  console.log(`  Balance:     ${ethers.formatEther(balance)} POL`);
  console.log(`  Network:     Polygon Amoy Testnet`);
  console.log(`  RPC:         ${RPC_URL.slice(0, 40)}...\n`);

  if (balance === 0n) {
    console.error('❌ Wallet has zero balance. Get test POL from the Amoy faucet.');
    console.error('   https://www.alchemy.com/faucets/polygon-amoy');
    process.exit(1);
  }

  // ── Read compiled contract ──
  // For simplicity, we compile inline. In production, use Hardhat.
  // This script uses the raw Solidity via a simple compile approach.
  // Actually, we need the bytecode. Let me read the contract and note that
  // the user needs to compile it first with Hardhat or Remix.
  
  console.log('📄 Reading contract source...\n');
  const contractPath = path.join(__dirname, '..', 'contracts', 'AcervisRegistry.sol');
  const source = fs.readFileSync(contractPath, 'utf8');
  
  // Check if compiled artifacts exist
  const artifactsPath = path.join(__dirname, '..', 'artifacts', 'contracts', 'AcervisRegistry.sol', 'AcervisRegistry.json');
  
  let bytecode, abi;
  
  if (fs.existsSync(artifactsPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
    bytecode = artifact.bytecode;
    abi = artifact.abi;
    console.log('   Found compiled artifacts.');
  } else {
    console.log('   No compiled artifacts found. For first-time deploy, you need to compile first:');
    console.log('   Option 1: Use Hardhat:   npx hardhat compile');
    console.log('   Option 2: Use Remix IDE:  Copy contract to remix.ethereum.org, compile, deploy from there.');
    console.log('   Option 3: Confirm and I\'ll generate the bytecode inline.\n');
    
    // Ask for confirmation to continue with inline-compiled bytecode approach
    console.log('   ⚠ For now, this script will output the deployment parameters.');
    console.log('   After deploying, update your .env with CONTRACT_ADDRESS.\n');
    
    console.log('═══════════════════════════════════════════');
    console.log('   DEPLOYMENT PARAMETERS');
    console.log('═══════════════════════════════════════════\n');
    console.log(`  Network:       Polygon Amoy`);
    console.log(`  Deployer:      ${wallet.address}`);
    console.log(`  Contract:      AcervisRegistry.sol`);
    console.log(`  Solidity:      ^0.8.20\n`);
    console.log('  1. Compile the contract using Hardhat or Remix');
    console.log('  2. Deploy to Polygon Amoy');
    console.log('  3. Copy the deployed address to .env as CONTRACT_ADDRESS');
    console.log('  4. Run this script again with --setup to authorize institutions\n');
    
    // Output the constructor call data
    console.log('   Constructor:   (none — super admin is set to deployer)');
    console.log(`   Super Admin:   ${wallet.address}\n`);
    
    // If --setup flag, offer to authorize institutions
    if (process.argv.includes('--setup')) {
      console.log('   --setup detected. You can run the following contract calls after deployment:\n');
      
      if (process.env.TEST_INSTITUTION_CODE) {
        const testWallet = ethers.Wallet.createRandom();
        console.log(`   authorizeInstitution("${testWallet.address}", "${process.env.TEST_INSTITUTION_NAME || 'Test University'}", ${process.env.TEST_INSTITUTION_QUOTA || 1000})`);
        console.log(`   Test wallet: ${testWallet.address}`);
        console.log(`   Save this wallet\'s private key as INSTITUTION_PRIVATE_KEY in .env\n`);
      }
    }

    console.log('═══════════════════════════════════════════\n');
    return;
  }

  // ── Deploy ──
  console.log('🚀 Deploying AcervisRegistry...');
  
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  
  const contractAddress = await contract.getAddress();
  const txHash = contract.deploymentTransaction().hash;
  
  console.log(`\n✅ Contract deployed!`);
  console.log(`   Address:    ${contractAddress}`);
  console.log(`   TX:         ${txHash}`);
  console.log(`   Super Admin: ${wallet.address}\n`);

  // ── Verify deployment ──
  const superAdmin = await contract.superAdmin();
  console.log(`   superAdmin():     ${superAdmin}`);
  console.log(`   Match deployer:   ${superAdmin.toLowerCase() === wallet.address.toLowerCase() ? '✅' : '❌'}\n`);

  // ── Authorize test institution (optional) ──
  if (process.argv.includes('--setup') && process.env.TEST_INSTITUTION_CODE) {
    console.log('📋 Setting up test institution...\n');
    
    const testWallet = ethers.Wallet.createRandom();
    const testName = process.env.TEST_INSTITUTION_NAME || 'Test University';
    const testQuota = parseInt(process.env.TEST_INSTITUTION_QUOTA || '1000', 10);
    
    const tx = await contract.authorizeInstitution(testWallet.address, testName, testQuota);
    await tx.wait();
    
    console.log(`   ✅ Institution authorized on-chain:`);
    console.log(`      Name:    ${testName}`);
    console.log(`      Wallet:  ${testWallet.address}`);
    console.log(`      Quota:   ${testQuota}\n`);
    console.log('   Add these to your .env:');
    console.log(`   INSTITUTION_PRIVATE_KEY=${testWallet.privateKey}`);
  }

  // ── Output .env additions ──
  console.log('═══════════════════════════════════════════');
  console.log('   ADD TO .ENV');
  console.log('═══════════════════════════════════════════\n');
  console.log(`CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`ALCHEMY_RPC_URL=${RPC_URL}\n`);
  
  if (process.env.MNEMONIC) {
    console.log('   Or use a mnemonic-based wallet:');
    console.log(`   MNEMONIC="${process.env.MNEMONIC}"\n`);
  }
  
  console.log('   To verify on Polygonscan:');
  console.log(`   npx hardhat verify --network amoy ${contractAddress}\n`);
}

main().catch(err => {
  console.error('\n❌ Deployment failed:', err.message);
  console.error(err);
  process.exit(1);
});
