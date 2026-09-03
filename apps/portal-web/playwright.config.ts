import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI'] ? [['line'], ['html', { open: 'never' }]] : 'line',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4210',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm start -- --host 127.0.0.1 --port 4210',
    url: 'http://127.0.0.1:4210/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
