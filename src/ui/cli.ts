#!/usr/bin/env node
/**
 * Axiom Viewer Bot CLI
 *
 * Terminal UI for managing accounts and viewer count
 */

import * as readline from 'readline';
import { AccountManager } from './account-manager';
import { ViewerService, type TokenInfo } from './viewer-service';

const accountManager = new AccountManager();
const viewerService = new ViewerService();

// ANSI colors
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

function clear(): void {
  console.clear();
}

function print(text: string = ''): void {
  console.log(text);
}

function printHeader(): void {
  print(`${colors.cyan}${colors.bright}`);
  print('╔════════════════════════════════════════════╗');
  print('║       AXIOM VIEWER BOT                     ║');
  print('╚════════════════════════════════════════════╝');
  print(`${colors.reset}`);
}

function printStatus(): void {
  const accountCount = accountManager.getAccountCount();
  const activeViewers = viewerService.getActiveCount();
  const pendingViewers = viewerService.getPendingCount();
  const gradualRunning = viewerService.isGradualRunning();

  print(`${colors.dim}─────────────────────────────────────────────${colors.reset}`);
  print(`${colors.yellow}Accounts:${colors.reset} ${accountCount}`);
  print(`${colors.green}Active Viewers:${colors.reset} ${activeViewers}`);
  if (gradualRunning) {
    print(`${colors.blue}Gradual Mode:${colors.reset} Running (${pendingViewers} pending)`);
  }
  print(`${colors.dim}─────────────────────────────────────────────${colors.reset}`);
}

function printMenu(): void {
  print(`
${colors.bright}Main Menu:${colors.reset}

  ${colors.cyan}1${colors.reset} - Manage Accounts
  ${colors.cyan}2${colors.reset} - Start Viewers
  ${colors.cyan}3${colors.reset} - Stop All Viewers
  ${colors.cyan}4${colors.reset} - View Status
  ${colors.cyan}q${colors.reset} - Quit
`);
}

function printAccountMenu(): void {
  print(`
${colors.bright}Account Management:${colors.reset}

  ${colors.cyan}1${colors.reset} - Create Accounts
  ${colors.cyan}2${colors.reset} - List Accounts
  ${colors.cyan}3${colors.reset} - Delete All Accounts
  ${colors.cyan}b${colors.reset} - Back
`);
}

function printViewerMenu(): void {
  print(`
${colors.bright}Start Viewers:${colors.reset}

  ${colors.cyan}1${colors.reset} - Immediate (add X viewers now)
  ${colors.cyan}2${colors.reset} - Gradual (add X viewers every Y seconds)
  ${colors.cyan}b${colors.reset} - Back
`);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.magenta}${question}${colors.reset} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptNumber(question: string, defaultVal?: number): Promise<number> {
  const defaultStr = defaultVal !== undefined ? ` (default: ${defaultVal})` : '';
  const answer = await prompt(`${question}${defaultStr}:`);
  const num = parseInt(answer, 10);
  if (isNaN(num)) {
    return defaultVal ?? 0;
  }
  return num;
}

async function handleCreateAccounts(): Promise<void> {
  const count = await promptNumber('How many accounts to create?', 10);

  if (count <= 0) {
    print(`${colors.red}Invalid count${colors.reset}`);
    return;
  }

  print(`\n${colors.yellow}Creating ${count} accounts...${colors.reset}\n`);

  const created = await accountManager.createAccounts(count, (done, total) => {
    process.stdout.write(`\r${colors.green}Progress: ${done}/${total}${colors.reset}`);
  });

  print(`\n\n${colors.green}✓ Created ${created} accounts${colors.reset}`);
  await prompt('Press Enter to continue...');
}

async function handleListAccounts(): Promise<void> {
  const accounts = accountManager.listAccounts();

  if (accounts.length === 0) {
    print(`\n${colors.yellow}No accounts found${colors.reset}`);
  } else {
    print(`\n${colors.bright}Accounts (${accounts.length}):${colors.reset}\n`);
    for (const acc of accounts.slice(0, 20)) {
      const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleDateString() : 'never';
      print(`  ${colors.cyan}#${acc.id}${colors.reset} - ${acc.publicKey.slice(0, 8)}... (last used: ${lastUsed})`);
    }
    if (accounts.length > 20) {
      print(`  ${colors.dim}... and ${accounts.length - 20} more${colors.reset}`);
    }
  }

  await prompt('\nPress Enter to continue...');
}

async function handleDeleteAllAccounts(): Promise<void> {
  const confirm = await prompt('Are you sure you want to delete ALL accounts? (yes/no):');

  if (confirm.toLowerCase() === 'yes') {
    accountManager.deleteAllAccounts();
    print(`${colors.green}✓ All accounts deleted${colors.reset}`);
  } else {
    print(`${colors.yellow}Cancelled${colors.reset}`);
  }

  await prompt('Press Enter to continue...');
}

async function accountMenu(): Promise<void> {
  while (true) {
    clear();
    printHeader();
    printStatus();
    printAccountMenu();

    const choice = await prompt('Select option:');

    switch (choice) {
      case '1':
        await handleCreateAccounts();
        break;
      case '2':
        await handleListAccounts();
        break;
      case '3':
        await handleDeleteAllAccounts();
        break;
      case 'b':
      case 'B':
        return;
      default:
        print(`${colors.red}Invalid option${colors.reset}`);
        await prompt('Press Enter to continue...');
    }
  }
}

async function handleImmediateViewers(): Promise<void> {
  const accountCount = accountManager.getAccountCount();

  if (accountCount === 0) {
    print(`\n${colors.red}No accounts available. Create accounts first.${colors.reset}`);
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

  if (tokenInfo) {
    print(`${colors.green}Token: ${tokenInfo.ticker} (${tokenInfo.name})${colors.reset}`);
    viewerService.setTokenInfo(tokenInfo);
  } else {
    print(`${colors.yellow}Could not fetch token info, using minimal data${colors.reset}`);
    viewerService.setTokenInfo({
      pairAddress,
      tokenAddress: '',
      ticker: 'TOKEN',
      name: 'Token',
      protocol: 'Pump V1',
      isMigrated: false,
      supply: 1000000000,
      price: 0
    });
  }

  const count = await promptNumber(`How many viewers? (max: ${accountCount})`, Math.min(10, accountCount));
  const finalCount = Math.min(count, accountCount);

  if (finalCount <= 0) {
    print(`${colors.red}Invalid count${colors.reset}`);
    await prompt('Press Enter to continue...');
    return;
  }

  print(`\n${colors.yellow}Connecting ${finalCount} viewers...${colors.reset}\n`);

  const accounts = accountManager.loadAllAccounts();
  const connected = await viewerService.startImmediate(accounts, finalCount);

  print(`\n${colors.green}✓ ${connected} viewers now active${colors.reset}`);
  await prompt('Press Enter to continue...');
}

async function handleGradualViewers(): Promise<void> {
  const accountCount = accountManager.getAccountCount();

  if (accountCount === 0) {
    print(`\n${colors.red}No accounts available. Create accounts first.${colors.reset}`);
    await prompt('Press Enter to continue...');
    return;
  }

  if (viewerService.isGradualRunning()) {
    print(`\n${colors.yellow}Gradual mode is already running. Stop it first.${colors.reset}`);
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

  if (tokenInfo) {
    print(`${colors.green}Token: ${tokenInfo.ticker} (${tokenInfo.name})${colors.reset}`);
    viewerService.setTokenInfo(tokenInfo);
  } else {
    print(`${colors.yellow}Could not fetch token info, using minimal data${colors.reset}`);
    viewerService.setTokenInfo({
      pairAddress,
      tokenAddress: '',
      ticker: 'TOKEN',
      name: 'Token',
      protocol: 'Pump V1',
      isMigrated: false,
      supply: 1000000000,
      price: 0
    });
  }

  const viewersPerInterval = await promptNumber('Viewers to add each interval:', 3);
  const intervalSeconds = await promptNumber('Interval in seconds:', 5);

  if (viewersPerInterval <= 0 || intervalSeconds <= 0) {
    print(`${colors.red}Invalid values${colors.reset}`);
    await prompt('Press Enter to continue...');
    return;
  }

  print(`\n${colors.green}Starting gradual mode: ${viewersPerInterval} viewers every ${intervalSeconds}s${colors.reset}`);
  print(`${colors.dim}(Will use up to ${accountCount} accounts)${colors.reset}\n`);

  const accounts = accountManager.loadAllAccounts();

  viewerService.on('gradual-tick', (active, pending) => {
    print(`${colors.cyan}[Gradual]${colors.reset} Active: ${active}, Pending: ${pending}`);
  });

  viewerService.on('gradual-complete', () => {
    print(`\n${colors.green}✓ Gradual mode complete - all accounts connected${colors.reset}`);
  });

  viewerService.startGradual(accounts, viewersPerInterval, intervalSeconds * 1000);

  print(`${colors.yellow}Gradual mode started. Return to main menu to monitor.${colors.reset}`);
  await prompt('Press Enter to continue...');
}

async function viewerMenu(): Promise<void> {
  while (true) {
    clear();
    printHeader();
    printStatus();
    printViewerMenu();

    const choice = await prompt('Select option:');

    switch (choice) {
      case '1':
        await handleImmediateViewers();
        break;
      case '2':
        await handleGradualViewers();
        break;
      case 'b':
      case 'B':
        return;
      default:
        print(`${colors.red}Invalid option${colors.reset}`);
        await prompt('Press Enter to continue...');
    }
  }
}

async function handleStopViewers(): Promise<void> {
  const activeCount = viewerService.getActiveCount();

  if (activeCount === 0 && !viewerService.isGradualRunning()) {
    print(`\n${colors.yellow}No active viewers${colors.reset}`);
  } else {
    viewerService.disconnectAll();
    print(`\n${colors.green}✓ All viewers stopped${colors.reset}`);
  }

  await prompt('Press Enter to continue...');
}

async function handleViewStatus(): Promise<void> {
  clear();
  printHeader();

  const accounts = accountManager.listAccounts();
  const activeViewers = viewerService.getActiveCount();
  const pendingViewers = viewerService.getPendingCount();
  const gradualRunning = viewerService.isGradualRunning();

  print(`\n${colors.bright}Status:${colors.reset}\n`);
  print(`  ${colors.yellow}Total Accounts:${colors.reset} ${accounts.length}`);
  print(`  ${colors.green}Active Viewers:${colors.reset} ${activeViewers}`);
  print(`  ${colors.blue}Gradual Mode:${colors.reset} ${gradualRunning ? `Running (${pendingViewers} pending)` : 'Stopped'}`);

  if (accounts.length > 0) {
    const recent = accounts.filter(a => a.lastUsed).slice(-5);
    if (recent.length > 0) {
      print(`\n${colors.bright}Recently Used Accounts:${colors.reset}`);
      for (const acc of recent) {
        print(`  #${acc.id} - ${acc.publicKey.slice(0, 8)}...`);
      }
    }
  }

  await prompt('\nPress Enter to continue...');
}

async function mainMenu(): Promise<void> {
  while (true) {
    clear();
    printHeader();
    printStatus();
    printMenu();

    const choice = await prompt('Select option:');

    switch (choice) {
      case '1':
        await accountMenu();
        break;
      case '2':
        await viewerMenu();
        break;
      case '3':
        await handleStopViewers();
        break;
      case '4':
        await handleViewStatus();
        break;
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

// Main entry point
async function main(): Promise<void> {
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    viewerService.disconnectAll();
    print(`\n${colors.green}Goodbye!${colors.reset}\n`);
    process.exit(0);
  });

  await mainMenu();
}

main().catch(console.error);
