/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as https from 'node:https';

export function getGitHubToken(): string | undefined {
  return process.env['GITHUB_TOKEN'];
}

/** Credentials belong to the GitHub API origin, never a release CDN or redirect target. */
export function githubRequestHeaders(
  url: string,
  additionalHeaders: Record<string, string> = {},
): Record<string, string> {
  const destination = new URL(url);
  if (
    destination.protocol !== 'https:' ||
    destination.username ||
    destination.password
  ) {
    throw new Error('GitHub downloads require a credential-free HTTPS URL');
  }
  const headers: Record<string, string> = {
    'User-Agent': 'gemini-cli',
    ...additionalHeaders,
  };
  // Header names are case insensitive. Remove any supplied authorization before
  // deciding whether this exact HTTPS origin may receive a GitHub credential.
  for (const name of Object.keys(headers)) {
    if (['authorization', 'proxy-authorization'].includes(name.toLowerCase())) {
      delete headers[name];
    }
  }
  if (destination.origin === 'https://api.github.com') {
    const token = getGitHubToken();
    if (token) headers['Authorization'] = `token ${token}`;
  }
  return headers;
}

export async function fetchJson<T>(
  url: string,
  redirectCount: number = 0,
): Promise<T> {
  const headers = githubRequestHeaders(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: T) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = https.get(url, { headers }, (res) => {
      let ended = false;
      const rejectResponse = (error: Error) => rejectOnce(error);
      res.once('error', rejectResponse);
      res.once('aborted', () => {
        rejectResponse(new Error(`Response aborted while fetching ${url}`));
      });
      res.once('close', () => {
        if (!ended && res.complete === false) {
          rejectResponse(
            new Error(`Response incomplete while fetching ${url}`),
          );
        }
      });

      if (res.statusCode === 302 || res.statusCode === 301) {
        if (redirectCount >= 10) {
          res.resume();
          return rejectOnce(new Error('Too many redirects'));
        }
        const location = res.headers.location;
        if (!location) {
          res.resume();
          return rejectOnce(
            new Error('No location header in redirect response'),
          );
        }
        res.resume();
        Promise.resolve()
          .then(() =>
            fetchJson<T>(new URL(location, url).toString(), redirectCount + 1),
          )
          .then(resolveOnce)
          .catch(rejectOnce);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return rejectOnce(
          new Error(`Request failed with status code ${res.statusCode}`),
        );
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
        if (res.complete === false) {
          rejectResponse(
            new Error(`Response incomplete while fetching ${url}`),
          );
          return;
        }
        const data = Buffer.concat(chunks).toString();
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          resolveOnce(JSON.parse(data) as T);
        } catch (error) {
          rejectResponse(
            new Error(
              `Failed to parse JSON response from ${url}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            ),
          );
        }
      });
    });
    request.once('error', rejectOnce);
  });
}
