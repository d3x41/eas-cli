import * as https from 'https';
import createHttpsProxyAgent from 'https-proxy-agent';
import mime from 'mime';
import { Gzip } from 'minizlib';
import fetch, { Headers, HeadersInit, RequestInit, Response } from 'node-fetch';
import fs, { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import promiseRetry from 'promise-retry';

const MAX_RETRIES = 4;
const MAX_CONCURRENCY = 10;
const MIN_RETRY_TIMEOUT = 100;
const MAX_UPLOAD_SIZE = 5e8; // 5MB
const MIN_COMPRESSION_SIZE = 5e4; // 50kB

const isCompressible = (contentType: string | null, size: number): boolean => {
  if (size < MIN_COMPRESSION_SIZE) {
    // Don't compress small files
    return false;
  } else if (contentType && /^(?:audio|video|image)\//i.test(contentType)) {
    // Never compress images, audio, or videos as they're presumably precompressed
    return false;
  } else if (contentType && /^application\//i.test(contentType)) {
    // Only compress `application/` files if they're marked as XML/JSON/JS
    return /(?:xml|json5?|javascript)$/i.test(contentType);
  } else {
    return true;
  }
};

const getContentTypeAsync = async (filePath: string): Promise<string | null> => {
  let contentType = mime.getType(path.basename(filePath));

  if (!contentType) {
    const fileContent = await readFile(filePath, 'utf-8');
    try {
      // check if file is valid JSON without an extension, e.g. for the apple app site association file
      const parsedData = JSON.parse(fileContent);

      if (parsedData) {
        contentType = 'application/json';
      }
    } catch {}
  }

  return contentType;
};

export interface UploadParams extends Omit<RequestInit, 'signal' | 'body'> {
  filePath: string;
  compress?: boolean;
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: undefined;
  signal?: AbortSignal;
}

export interface UploadResult {
  params: UploadParams;
  response: Response;
}

let sharedAgent: https.Agent | undefined;
const getAgent = (): https.Agent => {
  if (sharedAgent) {
    return sharedAgent;
  } else if (process.env.https_proxy) {
    return (sharedAgent = createHttpsProxyAgent(process.env.https_proxy));
  } else {
    return (sharedAgent = new https.Agent({
      keepAlive: true,
      maxSockets: MAX_CONCURRENCY,
      maxTotalSockets: MAX_CONCURRENCY,
      scheduling: 'lifo',
      timeout: 4_000,
    }));
  }
};

export async function uploadAsync(params: UploadParams): Promise<UploadResult> {
  const {
    filePath,
    signal,
    compress,
    method = 'POST',
    url,
    headers: headersInit,
    ...requestInit
  } = params;
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_UPLOAD_SIZE) {
    throw new Error(
      `Upload of "${filePath}" aborted: File size is greater than the upload limit (>500MB)`
    );
  }

  const contentType = await getContentTypeAsync(filePath);

  return await promiseRetry(
    async retry => {
      const headers = new Headers(headersInit);
      if (contentType) {
        headers.set('content-type', contentType);
      }

      let bodyStream: NodeJS.ReadableStream = createReadStream(filePath);
      if (compress && isCompressible(contentType, stat.size)) {
        const gzip = new Gzip({ portable: true });
        bodyStream.on('error', error => gzip.emit('error', error));
        // @ts-expect-error: Gzip implements a Readable-like interface
        bodyStream = bodyStream.pipe(gzip) as NodeJS.ReadableStream;
        headers.set('content-encoding', 'gzip');
      }

      let response: Response;
      try {
        response = await fetch(params.url, {
          ...requestInit,
          method,
          body: bodyStream,
          headers,
          agent: getAgent(),
          // @ts-expect-error: Internal types don't match
          signal,
        });
      } catch (error) {
        return retry(error);
      }

      const getErrorMessageAsync = async (): Promise<string> => {
        const rayId = response.headers.get('cf-ray');
        const contentType = response.headers.get('Content-Type');
        if (contentType?.startsWith('text/html')) {
          // NOTE(@kitten): We've received a CDN error most likely. There's not much we can do
          // except for quoting the Request ID, so a user can send it to us. We can check
          // why a request was blocked by looking up a WAF event via the "Ray ID" here:
          // https://dash.cloudflare.com/e6f39f67f543faa6038768e8f37e4234/expo.app/security/events
          let message = `CDN firewall has aborted the upload with ${response.statusText}.`;
          if (rayId) {
            message += `\nReport this error quoting Request ID ${rayId}`;
          }
          return `Upload of "${filePath}" failed: ${message}`;
        } else {
          const json = await response.json().catch(() => null);
          return json?.error ?? `Upload of "${filePath}" failed: ${response.statusText}`;
        }
      };

      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599)
      ) {
        return retry(new Error(await getErrorMessageAsync()));
      } else if (response.status === 413) {
        const message = `Upload of "${filePath}" failed: File size exceeded the upload limit`;
        throw new Error(message);
      } else if (!response.ok) {
        throw new Error(await getErrorMessageAsync());
      }

      return {
        params,
        response,
      };
    },
    {
      retries: MAX_RETRIES,
      minTimeout: MIN_RETRY_TIMEOUT,
      randomize: true,
      factor: 2,
    }
  );
}

export async function callUploadApiAsync(url: string | URL, init?: RequestInit): Promise<unknown> {
  return await promiseRetry(async retry => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        agent: getAgent(),
      });
    } catch (error) {
      return retry(error);
    }
    if (response.status >= 500 && response.status <= 599) {
      retry(new Error(`Deployment failed: ${response.statusText}`));
    }
    try {
      return await response.json();
    } catch (error) {
      retry(error);
    }
  });
}

export interface UploadPending {
  params: UploadParams;
}

export type BatchUploadSignal = UploadResult | UploadPending;

export async function* batchUploadAsync(
  uploads: readonly UploadParams[]
): AsyncGenerator<BatchUploadSignal> {
  const controller = new AbortController();
  const queue = new Set<Promise<UploadResult>>();
  try {
    let index = 0;
    while (index < uploads.length || queue.size > 0) {
      while (queue.size < MAX_CONCURRENCY && index < uploads.length) {
        const uploadParams = uploads[index++];
        let uploadPromise: Promise<UploadResult>;
        queue.add(
          (uploadPromise = uploadAsync({ ...uploadParams, signal: controller.signal }).finally(() =>
            queue.delete(uploadPromise)
          ))
        );
        yield { params: uploadParams };
      }
      yield await Promise.race(queue);
    }

    if (queue.size > 0) {
      controller.abort();
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      throw error;
    }
  }
}
