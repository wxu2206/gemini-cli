/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as https from 'node:https';
import { EventEmitter } from 'node:events';
import {
  fetchJson,
  getGitHubToken,
  githubRequestHeaders,
} from './github_fetch.js';
import type { ClientRequest, IncomingMessage } from 'node:http';

vi.mock('node:https');

describe('GitHub credential origin boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('authenticates the exact API origin and preserves non-sensitive custom headers', () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    expect(
      githubRequestHeaders('https://api.github.com/repos/fixture', {
        Accept: 'application/json',
      }),
    ).toMatchObject({
      Authorization: 'token fixture-token',
      Accept: 'application/json',
    });
  });

  it.each([
    'https://release-assets.githubusercontent.com/asset',
    'https://api.github.com.audit.invalid/',
    'https://audit.invalid/',
    'https://api.github.com:8443/',
  ])('never sends credentials to %s', (url) => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    const headers = githubRequestHeaders(url, {
      authorization: 'fixture-supplied',
      'Proxy-Authorization': 'fixture-proxy',
      Accept: 'application/octet-stream',
    });
    expect(Object.keys(headers).some((key) => /authorization/i.test(key))).toBe(
      false,
    );
    expect(headers['Accept']).toBe('application/octet-stream');
  });

  it.each(['http://api.github.com/', 'https://fixture@api.github.com/'])(
    'rejects unsafe destination %s before any request',
    async (url) => {
      await expect(fetchJson(url)).rejects.toThrow('credential-free HTTPS');
      expect(https.get).not.toHaveBeenCalled();
    },
  );

  it('strips credentials when a JSON request redirects away from the API', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    vi.mocked(https.get)
      .mockImplementationOnce((_url, options, callback) => {
        expect(options).toMatchObject({
          headers: { Authorization: 'token fixture-token' },
        });
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = 302;
        res.headers = { location: 'https://audit.invalid/asset' };
        res.resume = vi.fn();
        (callback as (res: IncomingMessage) => void)(res);
        return new EventEmitter() as ClientRequest;
      })
      .mockImplementationOnce((_url, options, callback) => {
        expect(options).toMatchObject({
          headers: { 'User-Agent': 'gemini-cli' },
        });
        expect(
          (options as { headers: Record<string, string> }).headers[
            'Authorization'
          ],
        ).toBeUndefined();
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = 200;
        (callback as (res: IncomingMessage) => void)(res);
        res.emit('data', Buffer.from('{"fixture":true}'));
        res.emit('end');
        return new EventEmitter() as ClientRequest;
      });
    await expect(fetchJson('https://api.github.com/fixture')).resolves.toEqual({
      fixture: true,
    });
  });
});

describe('getGitHubToken', () => {
  const originalToken = process.env['GITHUB_TOKEN'];

  afterEach(() => {
    if (originalToken) {
      process.env['GITHUB_TOKEN'] = originalToken;
    } else {
      delete process.env['GITHUB_TOKEN'];
    }
  });

  it('should return the token if GITHUB_TOKEN is set', () => {
    process.env['GITHUB_TOKEN'] = 'test-token';
    expect(getGitHubToken()).toBe('test-token');
  });

  it('should return undefined if GITHUB_TOKEN is not set', () => {
    delete process.env['GITHUB_TOKEN'];
    expect(getGitHubToken()).toBeUndefined();
  });
});

describe('fetchJson', () => {
  const getMock = vi.mocked(https.get);

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should fetch and parse JSON successfully', async () => {
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('data', Buffer.from('{"foo":'));
      res.emit('data', Buffer.from('"bar"}'));
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });
    await expect(fetchJson('https://example.com/data.json')).resolves.toEqual({
      foo: 'bar',
    });
  });

  it('should handle redirects (301 and 302)', async () => {
    // Test 302
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 302;
      res.headers = { location: 'https://example.com/final' };
      res.resume = vi.fn();
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });
    getMock.mockImplementationOnce((url, _options, callback) => {
      expect(url).toBe('https://example.com/final');
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('data', Buffer.from('{"success": true}'));
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });

    await expect(fetchJson('https://example.com/redirect')).resolves.toEqual({
      success: true,
    });

    // Test 301
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 301;
      res.headers = { location: 'https://example.com/final-permanent' };
      res.resume = vi.fn();
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });
    getMock.mockImplementationOnce((url, _options, callback) => {
      expect(url).toBe('https://example.com/final-permanent');
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('data', Buffer.from('{"permanent": true}'));
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });

    await expect(
      fetchJson('https://example.com/redirect-perm'),
    ).resolves.toEqual({ permanent: true });
  });

  it('should reject on non-200/30x status code', async () => {
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 404;
      res.resume = vi.fn();
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });

    await expect(fetchJson('https://example.com/error')).rejects.toThrow(
      'Request failed with status code 404',
    );
  });

  it('should reject on request error', async () => {
    const error = new Error('Network error');
    getMock.mockImplementationOnce(() => {
      const req = new EventEmitter() as ClientRequest;
      queueMicrotask(() => req.emit('error', error));
      return req;
    });

    await expect(fetchJson('https://example.com/error')).rejects.toThrow(
      'Network error',
    );
  });

  it('should reject malformed JSON through the Promise', async () => {
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('data', Buffer.from('{"foo": invalid}'));
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });

    await expect(fetchJson('https://api.github.com/malformed')).rejects.toThrow(
      'Failed to parse JSON response from https://api.github.com/malformed',
    );
  });

  it('should reject truncated JSON through the Promise', async () => {
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('data', Buffer.from('{"foo": "bar"'));
      res.emit('end');
      return new EventEmitter() as ClientRequest;
    });

    await expect(fetchJson('https://api.github.com/truncated')).rejects.toThrow(
      'Failed to parse JSON response from https://api.github.com/truncated',
    );
  });

  it('should reject on response error', async () => {
    const error = new Error('Response failed');
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      queueMicrotask(() => res.emit('error', error));
      return new EventEmitter() as ClientRequest;
    });

    await expect(
      fetchJson('https://api.github.com/response-error'),
    ).rejects.toThrow('Response failed');
  });

  it('should reject when the response is aborted', async () => {
    getMock.mockImplementationOnce((_url, _options, callback) => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = 200;
      (callback as (res: IncomingMessage) => void)(res);
      res.emit('aborted');
      return new EventEmitter() as ClientRequest;
    });

    await expect(fetchJson('https://api.github.com/aborted')).rejects.toThrow(
      'Response aborted while fetching https://api.github.com/aborted',
    );
  });

  describe('with GITHUB_TOKEN', () => {
    const originalToken = process.env['GITHUB_TOKEN'];

    beforeEach(() => {
      process.env['GITHUB_TOKEN'] = 'my-secret-token';
    });

    afterEach(() => {
      if (originalToken) {
        process.env['GITHUB_TOKEN'] = originalToken;
      } else {
        delete process.env['GITHUB_TOKEN'];
      }
    });

    it('should include Authorization header if token is present', async () => {
      getMock.mockImplementationOnce((_url, options, callback) => {
        expect(options.headers).toEqual({
          'User-Agent': 'gemini-cli',
          Authorization: 'token my-secret-token',
        });
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = 200;
        (callback as (res: IncomingMessage) => void)(res);
        res.emit('data', Buffer.from('{"foo": "bar"}'));
        res.emit('end');
        return new EventEmitter() as ClientRequest;
      });
      await expect(fetchJson('https://api.github.com/user')).resolves.toEqual({
        foo: 'bar',
      });
    });
  });

  describe('without GITHUB_TOKEN', () => {
    const originalToken = process.env['GITHUB_TOKEN'];

    beforeEach(() => {
      delete process.env['GITHUB_TOKEN'];
    });

    afterEach(() => {
      if (originalToken) {
        process.env['GITHUB_TOKEN'] = originalToken;
      }
    });

    it('should not include Authorization header if token is not present', async () => {
      getMock.mockImplementationOnce((_url, options, callback) => {
        expect(options.headers).toEqual({
          'User-Agent': 'gemini-cli',
        });
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = 200;
        (callback as (res: IncomingMessage) => void)(res);
        res.emit('data', Buffer.from('{"foo": "bar"}'));
        res.emit('end');
        return new EventEmitter() as ClientRequest;
      });

      await expect(fetchJson('https://api.github.com/user')).resolves.toEqual({
        foo: 'bar',
      });
    });
  });
});
