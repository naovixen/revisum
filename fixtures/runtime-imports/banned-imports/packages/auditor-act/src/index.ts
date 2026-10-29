import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const chromeOptions = require('selenium-webdriver/chrome');
