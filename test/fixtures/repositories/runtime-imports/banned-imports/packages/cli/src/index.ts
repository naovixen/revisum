export async function startBrowser(): Promise<unknown> {
  const puppeteer = await import('puppeteer-core');
  return puppeteer.launch({ headless: true });
}
