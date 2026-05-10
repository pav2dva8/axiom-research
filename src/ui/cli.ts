#!/usr/bin/env node
/**
 * Axiom Viewer Bot CLI
 *
 * Terminal UI for managing accounts and viewer count.
 * Source of truth for accounts: keys.txt (one base58 secret per line).
 */

import * as readline from 'readline';
import { AccountManager } from './account-manager';
import { ViewerService } from './viewer-service';

const accountManager = new AccountManager();
const viewerService = new ViewerService();

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function clear(): void { console.clear(); }
function print(text: string = ''): void { console.log(text); }

function printHeader(): void {
  print(`${colors.cyan}${colors.bright}`);
  print('+--------------------------------------------+');
  print('|       AXIOM VIEWER BOT                     |');
  print('+--------------------------------------------+');
  print(`${colors.reset}`);
}

function printStatus(): void {
  const accountCount = accountManager.getAccountCount();
  const activeViewers = viewerService.getActiveCount();
  print(`${colors.dim}---------------------------------------------${colors.reset}`);
  print(`${colors.yellow}Accounts:${colors.reset} ${accountCount}`);
  print(`${colors.green}Active Viewers:${colors.reset} ${activeViewers}`);
  print(`${colors.dim}---------------------------------------------${colors.reset}`);
}

function printMenu(): void {
  print(`
${colors.bright}Main Menu:${colors.reset}

  ${colors.cyan}1${colors.reset} - List Accounts
  ${colors.cyan}2${colors.reset} - Start Viewers
  ${colors.cyan}3${colors.reset} - Stop Viewers
  ${colors.cyan}q${colors.reset} - Quit
`);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${colors.magenta}${question}${colors.reset} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function handleListAccounts(): Promise<void> {
  const accounts = accountManager.listAccounts();
  if (accounts.length === 0) {
    print(`\n${colors.yellow}No accounts. Add base58 keys to keys.txt.${colors.reset}`);
  } else {
    print(`\n${colors.bright}Accounts (${accounts.length}):${colors.reset}\n`);
    for (const acc of accounts.slice(0, 50)) {
      const status = acc.tokenValid ? 'OK' : acc.hasTokens ? 'EXPIRED' : 'NO TOKENS';
      const sel = acc.selected ? '*' : ' ';
      print(`  ${sel} ${colors.cyan}${acc.publicKey.slice(0, 8)}...${colors.reset} [${status}]`);
    }
  }
  await prompt('\nPress Enter to continue...');
}

async function handleStartViewers(): Promise<void> {
  const accounts = accountManager.loadSelectedAccounts();
  if (accounts.length === 0) {
    print(`\n${colors.red}No accounts with valid tokens. Use the web UI to re-login.${colors.reset}`);
    await prompt('Press Enter to continue...');
    return;
  }

  const pairAddress = await prompt('Enter pair address:');
  if (!pairAddress) {
    print(`${colors.red}Pair address required${colors.reset}`);
    await prompt('Press Enter to continue...');
    return;
  }

  print(`\n${colors.yellow}Fetching token info...${colors.reset}`);
  const tokenInfo = await viewerService.fetchTokenInfo(pairAddress);
  viewerService.setTokenInfo(tokenInfo ?? {
    pairAddress, tokenAddress: '', ticker: 'TOKEN', name: 'Token',
    protocol: 'Pump V1', isMigrated: false, supply: 1000000000, price: 0,
  });

  print(`\n${colors.yellow}Connecting ${accounts.length} viewers (jittered)...${colors.reset}\n`);
  const connected = await viewerService.connectAll(accounts);
  print(`\n${colors.green}+ ${connected} viewers now active${colors.reset}`);
  await prompt('Press Enter to continue...');
}

async function handleStopViewers(): Promise<void> {
  if (viewerService.getActiveCount() === 0) {
    print(`\n${colors.yellow}No active viewers${colors.reset}`);
  } else {
    viewerService.disconnectAll();
    print(`\n${colors.green}+ All viewers stopped${colors.reset}`);
  }
  await prompt('Press Enter to continue...');
}

async function mainMenu(): Promise<void> {
  while (true) {
    clear();
    printHeader();
    printStatus();
    printMenu();

    const choice = await prompt('Select option:');
    switch (choice) {
      case '1': await handleListAccounts(); break;
      case '2': await handleStartViewers(); break;
      case '3': await handleStopViewers(); break;
      case 'q':
      case 'Q':
        viewerService.disconnectAll();
        print(`\n${colors.green}Goodbye!${colors.reset}\n`);
        process.exit(0);
      default:
        print(`${colors.red}Invalid option${colors.reset}`);
        await prompt('Press Enter to continue...');
    }
  }
}

async function main(): Promise<void> {
  process.on('SIGINT', () => {
    viewerService.disconnectAll();
    print(`\n${colors.green}Goodbye!${colors.reset}\n`);
    process.exit(0);
  });
  await mainMenu();
}

main().catch(console.error);
