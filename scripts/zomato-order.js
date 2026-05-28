#!/usr/bin/env node

/**
 * Zomato Order Automation Script
 * ===============================
 * Phase 1 (--setup): Opens browser for manual login, saves cookies
 * Phase 2 (default): Uses saved cookies to auto-login, lets user browse & order
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIE_PATH = '/tmp/zomato-cookies.json';
const PAYMENT_LINK_PATH = '/tmp/zomato-payment-link.txt';
const SCREENSHOT_PATH = '/tmp/zomato-state.png';

const ZOMATO_URL = 'https://www.zomato.com';

async function saveCookies(page) {
  const cookies = await page.context().cookies();
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log(`✅ Cookies saved to ${COOKIE_PATH}`);
}

async function loadCookies(context) {
  if (fs.existsSync(COOKIE_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
    await context.addCookies(cookies);
    console.log('✅ Cookies loaded — session restored');
    return true;
  }
  console.log('❌ No cookies found. Run with --setup first.');
  return false;
}

async function runSetup() {
  console.log('🚀 Phase 1 — Zomato Setup');
  console.log('Opening browser...');

  const browser = await chromium.launch({ headless: false, channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();

  await page.goto(ZOMATO_URL, { waitUntil: 'networkidle' });

  console.log('\n📋 Instructions:');
  console.log('  1. Log in to Zomato with your phone number');
  console.log('  2. Complete OTP verification');
  console.log('  3. Make sure your default delivery address is set');
  console.log('  4. Once logged in, press Enter in the terminal\n');

  await new Promise((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  // Save session cookies
  await saveCookies(page);
  await page.screenshot({ path: SCREENSHOT_PATH });

  console.log('✅ Setup complete! Cookies saved. You can now use auto-order.');
  await browser.close();
}

async function runAutoOrder() {
  console.log('🚀 Phase 2 — Zomato Auto-Order');

  if (!fs.existsSync(COOKIE_PATH)) {
    console.log('❌ No cookies found. Please run setup first: node scripts/zomato-order.js --setup');
    return;
  }

  const browser = await chromium.launch({ headless: false, channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  // Load saved cookies
  const loaded = await loadCookies(context);
  if (!loaded) {
    await browser.close();
    return;
  }

  const page = await context.newPage();

  try {
    await page.goto(ZOMATO_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✅ Logged in to Zomato automatically');

    // Take screenshot for debug
    await page.screenshot({ path: SCREENSHOT_PATH });

    console.log('\n📋 Instructions:');
    console.log('  1. Browse for restaurants and food items');
    console.log('  2. Add items to your cart');
    console.log('  3. Proceed to checkout');
    console.log('  4. When you reach the PAYMENT page (do NOT enter payment details),');
    console.log('     come back to the terminal and press Enter\n');

    console.log('⏳ Waiting for you to finish browsing...');

    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve());
    });

    // Capture the current URL (payment page)
    const currentUrl = page.url();
    console.log(`\n📍 Current page URL: ${currentUrl}`);

    // Save the payment link
    fs.writeFileSync(PAYMENT_LINK_PATH, currentUrl);
    console.log(`✅ Payment link saved to ${PAYMENT_LINK_PATH}`);

    console.log(`\n💰 Payment Link:`);
    console.log(`  ${currentUrl}`);
    console.log(`\n📌 Open this link to complete payment securely.`);
    console.log(`   The order will be placed once you pay.`);

  } catch (err) {
    console.error('❌ Error during auto-order:', err.message);

    // Check if session expired
    if (err.message.includes('timeout') || err.message.includes('network')) {
      console.log('\n⚠️  Session may have expired. Try running setup again:');
      console.log('   node scripts/zomato-order.js --setup');
    }
  } finally {
    // Keep browser open until user closes it or presses Enter
    console.log('\nPress Enter to close the browser...');
    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve());
    });
    await browser.close();
    console.log('✅ Browser closed.');
  }
}

// --- Main ---
const args = process.argv.slice(2);

if (args.includes('--setup')) {
  runSetup().catch(console.error);
} else {
  runAutoOrder().catch(console.error);
}
