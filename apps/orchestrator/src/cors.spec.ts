import { corsOptions } from './cors';

describe('corsOptions', () => {
  const original = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = original;
    }
  });

  it('reflects the request origin when CORS_ORIGIN is unset', () => {
    delete process.env.CORS_ORIGIN;
    expect(corsOptions()).toEqual({ origin: true });
  });

  it('splits a comma-separated CORS_ORIGIN into an allow-list, trimming whitespace', () => {
    process.env.CORS_ORIGIN =
      'http://localhost:3001, https://editor.example.com ';
    expect(corsOptions()).toEqual({
      origin: ['http://localhost:3001', 'https://editor.example.com'],
    });
  });
});
