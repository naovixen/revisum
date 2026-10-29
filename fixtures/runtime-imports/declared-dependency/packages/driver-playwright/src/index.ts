// The optional fallback adapter: the one package that may use Playwright.
import { chromium } from 'playwright-core';

export const launchFallback = () => chromium.launch({ headless: true });
