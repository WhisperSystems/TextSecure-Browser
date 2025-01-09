// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { Response } from 'node-fetch';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_JPEG, stringToMIMEType } from '../../types/MIME';
import type { LoggerType } from '../../types/Logging';

import {
  fetchLinkPreviewImage,
  fetchLinkPreviewMetadata,
} from '../../linkPreviews/linkPreviewFetch';

describe('link preview fetching', () => {
  // We'll use this to create a fake `fetch`. We'll want to call `.resolves` or
  //   `.rejects` on it (meaning that it needs to be a Sinon Stub type), but we'll also
  //   want it to be a fake `fetch`. `any` seems like the best "supertype" there.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stub(): any {
    return sinon.stub();
  }

  let warn: sinon.SinonStub;
  let logger: Pick<LoggerType, 'warn'>;

  beforeEach(() => {
    warn = sinon.stub();
    logger = { warn };
  });

  describe('fetchLinkPreviewMetadata', () => {
    const makeHtml = (stuffInHead: ReadonlyArray<string> = []) => `
    <!doctype html>
    <html>
      <head>${stuffInHead.join('\n')}</head>
      <body>should be ignored</body>
    </html>
    `;

    const makeResponse = ({
      status = 200,
      headers = {},
      body = makeHtml(['<title>test title</title>']),
      url = 'https://example.com',
    }: {
      status?: number;
      headers?: { [key: string]: null | string };
      body?: null | string | Uint8Array | AsyncIterable<Uint8Array>;
      url?: string;
    } = {}) => {
      let bodyLength: null | number;
      let bodyStream: null | AsyncIterable<Uint8Array>;
      if (!body) {
        bodyLength = 0;
        bodyStream = null;
      } else if (typeof body === 'string') {
        const asBytes = new TextEncoder().encode(body);
        bodyLength = asBytes.length;
        bodyStream = (async function* stream() {
          yield asBytes;
        })();
      } else if (body instanceof Uint8Array) {
        bodyLength = body.length;
        bodyStream = (async function* stream() {
          yield body;
        })();
      } else {
        bodyLength = null;
        bodyStream = body;
      }

      const headersObj = new Headers();
      Object.entries({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': bodyLength == null ? null : String(bodyLength),
        ...headers,
      }).forEach(([headerName, headerValue]) => {
        if (headerValue) {
          headersObj.set(headerName, headerValue);
        }
      });

      return {
        headers: headersObj,
        body: bodyStream,
        ok: status >= 200 && status <= 299,
        status,
        url,
      };
    };

    it('handles the "kitchen sink" of results', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<meta property="og:title" content="test title">',
            '<meta property="og:description" content="test description">',
            '<meta property="og:image" content="https://example.com/image.jpg">',
            '<meta property="og:published_time" content="2020-04-20T12:34:56.009Z">',
          ]),
        })
      );

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: 'test title',
          description: 'test description',
          date: 1587386096009,
          imageHref: 'https://example.com/image.jpg',
        }
      );
    });

    it('handles image href sources in the correct order', async () => {
      const orderedImageHrefSources = [
        {
          tag: '<meta property="og:image" content="https://example.com/og-image.jpg">',
          expectedHref: 'https://example.com/og-image.jpg',
        },
        {
          tag: '<meta property="og:image:url" content="https://example.com/og-image-url.jpg">',
          expectedHref: 'https://example.com/og-image-url.jpg',
        },
        {
          tag: '<link rel="apple-touch-icon" href="https://example.com/apple-touch-icon.jpg">',
          expectedHref: 'https://example.com/apple-touch-icon.jpg',
        },
        {
          tag: '<link rel="apple-touch-icon-precomposed" href="https://example.com/apple-touch-icon-precomposed.jpg">',
          expectedHref: 'https://example.com/apple-touch-icon-precomposed.jpg',
        },
        {
          tag: '<link rel="shortcut icon" href="https://example.com/shortcut-icon.jpg">',
          expectedHref: 'https://example.com/shortcut-icon.jpg',
        },
        {
          tag: '<link rel="icon" href="https://example.com/icon.jpg">',
          expectedHref: 'https://example.com/icon.jpg',
        },
      ];
      for (let i = orderedImageHrefSources.length - 1; i >= 0; i -= 1) {
        const imageTags = orderedImageHrefSources
          .slice(i)
          .map(({ tag }) => tag)
          // Reverse the array to make sure that we're prioritizing properly,
          //   instead of just using whichever comes first.
          .reverse();
        const fakeFetch = stub().resolves(
          makeResponse({
            body: makeHtml([
              '<meta property="og:title" content="test title">',
              ...imageTags,
            ]),
          })
        );

        // eslint-disable-next-line no-await-in-loop
        const val = await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        );
        assert.propertyVal(
          val,
          'imageHref',
          orderedImageHrefSources[i].expectedHref
        );
      }
    });

    it('logs no warnings if everything goes smoothly', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<meta property="og:title" content="test title">',
            '<meta property="og:description" content="test description">',
            '<meta property="og:image" content="https://example.com/image.jpg">',
            '<meta property="og:published_time" content="2020-04-20T12:34:56.009Z">',
          ]),
        })
      );

      await fetchLinkPreviewMetadata(
        fakeFetch,
        'https://example.com',
        new AbortController().signal,
        logger
      );

      sinon.assert.notCalled(warn);
    });

    it('sends WhatsApp as the User-Agent for compatibility', async () => {
      const fakeFetch = stub().resolves(makeResponse());

      await fetchLinkPreviewMetadata(
        fakeFetch,
        'https://example.com',
        new AbortController().signal
      );

      sinon.assert.calledWith(
        fakeFetch,
        'https://example.com',
        sinon.match({
          headers: {
            'User-Agent': 'WhatsApp/2',
          },
        })
      );
    });

    it('returns null if the request fails', async () => {
      const fakeFetch = stub().rejects(new Error('Test request failure'));

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewMetadata: failed to fetch link preview HTML; bailing'
      );
    });

    it("returns null if the response status code isn't 2xx", async () => {
      await Promise.all(
        [100, 304, 400, 404, 500, 0, -200].map(async status => {
          const fakeFetch = stub().resolves(makeResponse({ status }));

          assert.isNull(
            await fetchLinkPreviewMetadata(
              fakeFetch,
              'https://example.com',
              new AbortController().signal,
              logger
            )
          );

          sinon.assert.calledWith(
            warn,
            `fetchLinkPreviewMetadata: got a ${status} status code; bailing`
          );
        })
      );
    });

    it("doesn't use fetch's automatic redirection behavior", async () => {
      const fakeFetch = stub().resolves(makeResponse());

      await fetchLinkPreviewMetadata(
        fakeFetch,
        'https://example.com',
        new AbortController().signal
      );

      sinon.assert.calledWith(
        fakeFetch,
        'https://example.com',
        sinon.match({ redirect: 'manual' })
      );
    });

    [301, 302, 303, 307, 308].forEach(status => {
      it(`handles ${status} redirects`, async () => {
        const fakeFetch = stub();
        fakeFetch.onFirstCall().resolves(
          makeResponse({
            status,
            headers: { Location: 'https://example.com/2' },
            body: null,
          })
        );
        fakeFetch.onSecondCall().resolves(makeResponse());

        assert.deepEqual(
          await fetchLinkPreviewMetadata(
            fakeFetch,
            'https://example.com',
            new AbortController().signal
          ),
          {
            title: 'test title',
            description: null,
            date: null,
            imageHref: null,
          }
        );

        sinon.assert.calledTwice(fakeFetch);
        sinon.assert.calledWith(fakeFetch.getCall(0), 'https://example.com');
        sinon.assert.calledWith(fakeFetch.getCall(1), 'https://example.com/2');
      });

      it(`returns null when seeing a ${status} status with no Location header`, async () => {
        const fakeFetch = stub().resolves(makeResponse({ status }));

        assert.isNull(
          await fetchLinkPreviewMetadata(
            fakeFetch,
            'https://example.com',
            new AbortController().signal
          )
        );
      });
    });

    it('handles relative redirects', async () => {
      const fakeFetch = stub();
      fakeFetch.onFirstCall().resolves(
        makeResponse({
          status: 301,
          headers: { Location: '/2/' },
          body: null,
        })
      );
      fakeFetch.onSecondCall().resolves(
        makeResponse({
          status: 301,
          headers: { Location: '3' },
          body: null,
        })
      );
      fakeFetch.onThirdCall().resolves(makeResponse());

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: 'test title',
          description: null,
          date: null,
          imageHref: null,
        }
      );

      sinon.assert.calledThrice(fakeFetch);
      sinon.assert.calledWith(fakeFetch.getCall(0), 'https://example.com');
      sinon.assert.calledWith(fakeFetch.getCall(1), 'https://example.com/2/');
      sinon.assert.calledWith(fakeFetch.getCall(2), 'https://example.com/2/3');
    });

    it('returns null if redirecting to an insecure HTTP URL', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          status: 301,
          headers: { Location: 'http://example.com' },
          body: null,
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        )
      );

      sinon.assert.calledOnce(fakeFetch);
    });

    it("returns null if there's a redirection loop", async () => {
      const fakeFetch = stub();
      fakeFetch.onFirstCall().resolves(
        makeResponse({
          status: 301,
          headers: { Location: '/2/' },
          body: null,
        })
      );
      fakeFetch.onSecondCall().resolves(
        makeResponse({
          status: 301,
          headers: { Location: '/start' },
          body: null,
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com/start',
          new AbortController().signal
        )
      );

      sinon.assert.calledTwice(fakeFetch);
    });

    it('returns null if redirecting more than 20 times', async () => {
      const fakeFetch = stub().callsFake(async () =>
        makeResponse({
          status: 301,
          headers: { Location: `/${Math.random()}` },
          body: null,
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com/start',
          new AbortController().signal
        )
      );

      sinon.assert.callCount(fakeFetch, 20);
    });

    it('returns null if the response has no body', async () => {
      const fakeFetch = stub().resolves(makeResponse({ body: null }));

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewMetadata: no response body; bailing'
      );
    });

    it('returns null if the result body is too short', async () => {
      const fakeFetch = stub().resolves(makeResponse({ body: '<title>' }));

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewMetadata: Content-Length is too short; bailing'
      );
    });

    it('returns null if the result is meant to be downloaded', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: { 'Content-Disposition': 'attachment' },
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewMetadata: Content-Disposition header is not inline; bailing'
      );
    });

    it('allows an explicitly inline Content-Disposition header', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: { 'Content-Disposition': 'inline' },
        })
      );

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: 'test title',
          description: null,
          date: null,
          imageHref: null,
        }
      );
    });

    it('returns null if the Content-Type is not HTML', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: { 'Content-Type': 'text/plain' },
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewMetadata: Content-Type is not HTML; bailing'
      );
    });

    it('accepts non-lowercase Content-Type headers', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: { 'Content-Type': 'TEXT/HTML; chArsEt=utf-8' },
        })
      );

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: 'test title',
          description: null,
          date: null,
          imageHref: null,
        }
      );
    });

    it('parses the response as UTF-8 if the body contains a byte order mark', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html',
          },
          body: (async function* body() {
            yield new Uint8Array([0xef, 0xbb, 0xbf]);
            yield new TextEncoder().encode(
              '<!doctype html><title>\u{1F389}</title>'
            );
          })(),
        })
      );

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: '🎉',
          description: null,
          date: null,
          imageHref: null,
        }
      );
    });

    it('respects the UTF-8 byte order mark above the Content-Type header', async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const titleHtml = new TextEncoder().encode('<title>\u{1F389}</title>');

      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html; charset=latin1',
          },
          body: (async function* body() {
            yield bom;
            yield titleHtml;
          })(),
        })
      );
      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        '🎉'
      );
    });

    it('respects the UTF-8 byte order mark above a <meta http-equiv> in the document', async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const titleHtml = new TextEncoder().encode('<title>\u{1F389}</title>');
      const endHeadHtml = new TextEncoder().encode('</head>');

      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html',
          },
          body: (async function* body() {
            yield bom;
            yield new TextEncoder().encode(
              '<!doctype html><head><meta http-equiv="content-type" content="text/html; charset=latin1">'
            );
            yield titleHtml;
            yield endHeadHtml;
          })(),
        })
      );
      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        '🎉'
      );
    });

    it('respects the UTF-8 byte order mark above a <meta charset> in the document', async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const titleHtml = new TextEncoder().encode('<title>\u{1F389}</title>');
      const endHeadHtml = new TextEncoder().encode('</head>');

      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html',
          },
          body: (async function* body() {
            yield bom;
            yield new TextEncoder().encode(
              '<!doctype html><head><meta charset="utf-8">'
            );
            yield titleHtml;
            yield endHeadHtml;
          })(),
        })
      );
      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        '🎉'
      );
    });

    it('respects the Content-Type header above anything in the HTML', async () => {
      const titleHtml = new TextEncoder().encode('<title>\u{1F389}</title>');
      const endHeadHtml = new TextEncoder().encode('</head>');

      {
        const fakeFetch = stub().resolves(
          makeResponse({
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
            },
            body: (async function* body() {
              yield new TextEncoder().encode(
                '<!doctype html><head><meta http-equiv="content-type" content="text/html; charset=latin1">'
              );
              yield titleHtml;
              yield endHeadHtml;
            })(),
          })
        );
        assert.propertyVal(
          await fetchLinkPreviewMetadata(
            fakeFetch,
            'https://example.com',
            new AbortController().signal
          ),
          'title',
          '🎉'
        );
      }

      {
        const fakeFetch = stub().resolves(
          makeResponse({
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
            },
            body: (async function* body() {
              yield new TextEncoder().encode(
                '<!doctype html><head><meta charset="utf-8">'
              );
              yield titleHtml;
              yield endHeadHtml;
            })(),
          })
        );
        assert.propertyVal(
          await fetchLinkPreviewMetadata(
            fakeFetch,
            'https://example.com',
            new AbortController().signal
          ),
          'title',
          '🎉'
        );
      }
    });

    it('prefers the Content-Type http-equiv in the HTML above <meta charset>', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html',
          },
          body: makeHtml([
            '<meta http-equiv="content-type" content="text/html; charset=utf8">',
            '<meta charset="latin1">',
            '<title>\u{1F389}</title>',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        '🎉'
      );
    });

    it('parses non-UTF8 encodings', async () => {
      const titleBytes = new Uint8Array([0x61, 0x71, 0x75, 0xed]);
      assert.notDeepEqual(
        new TextDecoder('utf8').decode(titleBytes),
        new TextDecoder('latin1').decode(titleBytes),
        'Test data was not set up correctly'
      );

      const fakeFetch = stub().resolves(
        makeResponse({
          headers: {
            'Content-Type': 'text/html; charset=latin1',
          },
          body: (async function* body() {
            yield new TextEncoder().encode('<title>');
            yield titleBytes;
            yield new TextEncoder().encode('</title>');
          })(),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        'aquí'
      );
    });

    it('handles incomplete bodies', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: (async function* body() {
            yield new TextEncoder().encode(
              '<!doctype html><head><title>foo bar</title><meta'
            );
            throw new Error('Test request error');
          })(),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        ),
        'title',
        'foo bar'
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'getHtmlDocument: error when reading body; continuing with what we got'
      );
    });

    it('stops reading the body after cancellation', async () => {
      const shouldNeverBeCalled = sinon.stub();

      const abortController = new AbortController();

      const fakeFetch = stub().resolves(
        makeResponse({
          body: (async function* body() {
            yield new TextEncoder().encode('<!doctype html><head>');
            abortController.abort();
            yield new TextEncoder().encode('<title>should be dropped</title>');
            shouldNeverBeCalled();
          })(),
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          abortController.signal
        )
      );

      sinon.assert.notCalled(shouldNeverBeCalled);
    });

    it('stops reading bodies after 1000 kilobytes', async () => {
      const shouldNeverBeCalled = sinon.stub();

      const fakeFetch = stub().resolves(
        makeResponse({
          body: (async function* () {
            yield new TextEncoder().encode(
              '<!doctype html><head><title>foo bar</title>'
            );
            const spaces = new Uint8Array(250 * 1024).fill(32);
            yield spaces;
            yield spaces;
            yield spaces;
            yield spaces;
            yield spaces;
            shouldNeverBeCalled();
            yield new TextEncoder().encode(
              '<meta property="og:description" content="should be ignored">'
            );
          })(),
        })
      );

      assert.deepEqual(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        {
          title: 'foo bar',
          description: null,
          date: null,
          imageHref: null,
        }
      );

      sinon.assert.notCalled(shouldNeverBeCalled);
    });

    it("returns null if the HTML doesn't contain a title, even if it contains other values", async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<meta property="og:description" content="ignored">',
            '<meta property="og:image" content="https://example.com/ignored.jpg">',
            `<meta property="og:published_time" content="${new Date().toISOString()}">`,
          ]),
        })
      );

      assert.isNull(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        "parseMetadata: HTML document doesn't have a title; bailing"
      );
    });

    it('prefers og:title to document.title', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>ignored</title>',
            '<meta property="og:title" content="foo bar">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'title',
        'foo bar'
      );
    });

    it('prefers og:description to <meta name="description">', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta name="description" content="ignored">',
            '<meta property="og:description" content="bar">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'description',
        'bar'
      );
    });

    it('parses <meta name="description">', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta name="description" content="bar">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'description',
        'bar'
      );
    });

    it('ignores empty descriptions', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:description" content="">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'description',
        null
      );
    });

    it('parses absolute image URLs', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:image" content="https://example.com/image.jpg">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'imageHref',
        'https://example.com/image.jpg'
      );
    });

    it('parses relative image URLs', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:image" content="assets/image.jpg">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'imageHref',
        'https://example.com/assets/image.jpg'
      );
    });

    it('relative image URL resolution is relative to the final URL after redirects, not the original URL', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:image" content="image.jpg">',
          ]),
          url: 'https://bar.example/assets/',
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://foo.example',
          new AbortController().signal
        ),
        'imageHref',
        'https://bar.example/assets/image.jpg'
      );
    });

    it('ignores empty image URLs', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:image" content="">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'imageHref',
        null
      );
    });

    it('ignores blank image URLs', async () => {
      const fakeFetch = stub().resolves(
        makeResponse({
          body: makeHtml([
            '<title>foo</title>',
            '<meta property="og:image" content="  ">',
          ]),
        })
      );

      assert.propertyVal(
        await fetchLinkPreviewMetadata(
          fakeFetch,
          'https://example.com',
          new AbortController().signal
        ),
        'imageHref',
        null
      );
    });
  });

  describe('fetchLinkPreviewImage', () => {
    const readFixture = async (filename: string): Promise<Uint8Array> => {
      const result = await fs.promises.readFile(
        path.join(__dirname, '..', '..', '..', 'fixtures', filename)
      );
      assert(result.length > 10, `Test failed to read fixture ${filename}`);
      return result;
    };

    [
      {
        title: 'JPEG',
        contentType: 'image/jpeg',
        fixtureFilename: 'kitten-1-64-64.jpg',
      },
      {
        title: 'PNG',
        contentType: 'image/png',
        fixtureFilename:
          'freepngs-2cd43b_bed7d1327e88454487397574d87b64dc_mv2.png',
      },
      {
        title: 'GIF',
        contentType: 'image/gif',
        fixtureFilename: 'giphy-GVNvOUpeYmI7e.gif',
      },
      {
        title: 'WEBP',
        contentType: 'image/webp',
        fixtureFilename: '512x515-thumbs-up-lincoln.webp',
      },
      {
        title: 'ICO',
        contentType: 'image/x-icon',
        fixtureFilename: 'kitten-1-64-64.ico',
      },
    ].forEach(({ title, contentType, fixtureFilename }) => {
      it(`handles ${title} images`, async () => {
        const fixture = await readFixture(fixtureFilename);

        const fakeFetch = stub().resolves(
          new Response(fixture, {
            headers: {
              'Content-Type': contentType,
              'Content-Length': fixture.length.toString(),
            },
          })
        );

        assert.deepEqual(
          (
            await fetchLinkPreviewImage(
              fakeFetch,
              'https://example.com/img',
              new AbortController().signal
            )
          )?.contentType,
          stringToMIMEType(contentType)
        );
      });
    });

    it('returns null if the request fails', async () => {
      const fakeFetch = stub().rejects(new Error('Test request failure'));

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewImage: failed to fetch image; bailing'
      );
    });

    it("returns null if the response status code isn't 2xx", async () => {
      const fixture = await readFixture('kitten-1-64-64.jpg');

      await Promise.all(
        [400, 404, 500, 598].map(async status => {
          const fakeFetch = stub().resolves(
            new Response(fixture, {
              status,
              headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': fixture.length.toString(),
              },
            })
          );

          assert.isNull(
            await fetchLinkPreviewImage(
              fakeFetch,
              'https://example.com/img',
              new AbortController().signal,
              logger
            )
          );

          sinon.assert.calledWith(
            warn,
            `fetchLinkPreviewImage: got a ${status} status code; bailing`
          );
        })
      );
    });

    // Most of the redirect behavior is tested above.
    it('handles 301 redirects', async () => {
      const fixture = await readFixture('kitten-1-64-64.jpg');

      const fakeFetch = stub();
      fakeFetch.onFirstCall().resolves(
        new Response(Buffer.from(''), {
          status: 301,
          headers: {
            Location: '/result.jpg',
          },
        })
      );
      fakeFetch.onSecondCall().resolves(
        new Response(fixture, {
          headers: {
            'Content-Type': IMAGE_JPEG,
            'Content-Length': fixture.length.toString(),
          },
        })
      );

      assert.deepEqual(
        (
          await fetchLinkPreviewImage(
            fakeFetch,
            'https://example.com/img',
            new AbortController().signal
          )
        )?.contentType,
        IMAGE_JPEG
      );

      sinon.assert.calledTwice(fakeFetch);
      sinon.assert.calledWith(fakeFetch.getCall(0), 'https://example.com/img');
      sinon.assert.calledWith(
        fakeFetch.getCall(1),
        'https://example.com/result.jpg'
      );
    });

    it('returns null if the response is too small', async () => {
      const fakeFetch = stub().resolves(
        new Response(await readFixture('kitten-1-64-64.jpg'), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': '2',
          },
        })
      );

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewImage: Content-Length is too short; bailing'
      );
    });

    it('returns null if the Content-Length is too large', async () => {
      const fakeFetch = stub().resolves(
        new Response(await readFixture('kitten-1-64-64.jpg'), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': '123456789',
          },
        })
      );

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewImage: Content-Length is too large; bailing'
      );
    });

    it('returns null if the actual image is too large', async () => {
      const fakeFetch = stub().resolves(
        new Response(await readFixture('tina-rolf-269345-unsplash.jpg'), {
          headers: {
            'Content-Type': 'image/jpeg',
          },
        })
      );

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          new AbortController().signal,
          logger
        )
      );

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWith(
        warn,
        'fetchLinkPreviewImage: Image size is too large; bailing'
      );
    });

    it('returns null if the Content-Type is not a valid image', async () => {
      const fixture = await readFixture('kitten-1-64-64.jpg');

      await Promise.all(
        ['', 'image/tiff', 'video/mp4', 'text/plain', 'application/html'].map(
          async contentType => {
            const fakeFetch = stub().resolves(
              new Response(fixture, {
                headers: {
                  'Content-Type': contentType,
                  'Content-Length': fixture.length.toString(),
                },
              })
            );

            assert.isNull(
              await fetchLinkPreviewImage(
                fakeFetch,
                'https://example.com/img',
                new AbortController().signal,
                logger
              )
            );

            sinon.assert.calledWith(
              warn,
              'fetchLinkPreviewImage: Content-Type is not an image; bailing'
            );
          }
        )
      );
    });

    it('sends WhatsApp as the User-Agent for compatibility', async () => {
      const fakeFetch = stub().resolves(new Response(Buffer.from('')));

      await fetchLinkPreviewImage(
        fakeFetch,
        'https://example.com/img',
        new AbortController().signal
      );

      sinon.assert.calledWith(
        fakeFetch,
        'https://example.com/img',
        sinon.match({
          headers: {
            'User-Agent': 'WhatsApp/2',
          },
        })
      );
    });

    it("doesn't read the image if the request was aborted before reading started", async () => {
      const abortController = new AbortController();

      const fixture = await readFixture('kitten-1-64-64.jpg');

      const fakeFetch = stub().callsFake(() => {
        const response = new Response(fixture, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': fixture.length.toString(),
          },
        });
        sinon
          .stub(response, 'buffer')
          .rejects(new Error('Should not be called'));
        sinon.stub(response, 'blob').rejects(new Error('Should not be called'));
        sinon.stub(response, 'text').rejects(new Error('Should not be called'));
        sinon.stub(response, 'body').get(() => {
          throw new Error('Should not be accessed');
        });

        abortController.abort();

        return response;
      });

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          abortController.signal
        )
      );
    });

    it('returns null if the request was aborted after the image was read', async () => {
      const abortController = new AbortController();

      const fixture = await readFixture('kitten-1-64-64.jpg');

      const fakeFetch = stub().callsFake(() => {
        const response = new Response(fixture, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': fixture.length.toString(),
          },
        });
        const oldBufferMethod = response.buffer.bind(response);
        sinon.stub(response, 'buffer').callsFake(async () => {
          const data = await oldBufferMethod();
          abortController.abort();
          return data;
        });
        return response;
      });

      assert.isNull(
        await fetchLinkPreviewImage(
          fakeFetch,
          'https://example.com/img',
          abortController.signal
        )
      );
    });
  });
});
