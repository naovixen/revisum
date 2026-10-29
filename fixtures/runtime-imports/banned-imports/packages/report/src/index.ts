import { chromium } from 'playwright';

export const launchReportBrowser = () => chromium.launch({ headless: true });
