import { corsOrigins } from './security-http';

describe('corsOrigins', () => {
  it('solo acepta la allowlist HTTPS explícita en producción', () => {
    expect(
      corsOrigins({
        DEPLOYMENT_MODE: 'production',
        CORS_ORIGIN: 'https://portal.example.com,https://noc.example.com/',
      }),
    ).toEqual(['https://portal.example.com', 'https://noc.example.com']);
  });

  it('rechaza wildcard, paths y HTTP productivo', () => {
    expect(() =>
      corsOrigins({ DEPLOYMENT_MODE: 'production', CORS_ORIGIN: '*' }),
    ).toThrow('wildcard');
    expect(() =>
      corsOrigins({
        DEPLOYMENT_MODE: 'production',
        CORS_ORIGIN: 'https://example.com/path',
      }),
    ).toThrow('scheme');
    expect(() =>
      corsOrigins({
        DEPLOYMENT_MODE: 'production',
        CORS_ORIGIN: 'http://example.com',
      }),
    ).toThrow('HTTPS');
  });

  it('exige configuración explícita en producción', () => {
    expect(() => corsOrigins({ DEPLOYMENT_MODE: 'production' })).toThrow(
      'obligatorio',
    );
  });

  it('limita desarrollo a loopback y orígenes declarados', () => {
    expect(corsOrigins({ CORS_ORIGIN: 'http://10.10.0.2:4200' })).toEqual([
      'http://10.10.0.2:4200',
      'http://localhost:4200',
      'http://127.0.0.1:4200',
    ]);
  });
});
