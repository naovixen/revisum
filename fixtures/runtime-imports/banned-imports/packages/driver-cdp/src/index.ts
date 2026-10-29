import { launch } from 'puppeteer';

export const launchChromium = () => launch({ headless: true });
