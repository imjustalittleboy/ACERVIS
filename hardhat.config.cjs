// ACERVIS: Hardhat Configuration
require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris'
    }
  },
  networks: {
    amoy: {
      url: process.env.ALCHEMY_RPC_URL || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 80002
    }
  },
  etherscan: {
    apiKey: process.env.POLYGONSCAN_API_KEY || ''
  }
};
