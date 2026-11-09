import { chromium } from 'playwright-core';

export const auditBrowser = () => chromium.launch({ headless: true });
