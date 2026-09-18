/* eslint @typescript-eslint/no-var-requires: "off" */
const { i18n } = require('./next-i18next.config');
const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `@coreframe-relay/types` ships TypeScript source, not a build artifact — it is the
  // shared contract, and a build step between editing a schema and seeing it in both apps
  // is exactly the drift the package exists to prevent. Next must therefore compile it.
  transpilePackages: ['@coreframe-relay/types'],

  // RELAY-167 — Vercel runtime crashed with
  // "Cannot find module '.../.next/server/pages/500.js'" when an API route
  // threw at module load and Next tried to fall back to the custom error page.
  //
  // Root cause: Next's own error-rendering fallback (render500/_error) requires
  // pages/500.js, pages/_error.js and _app/_document at runtime, but nothing in
  // an API route's *source* imports them, so @vercel/nft's static trace for
  // each route lambda never picks them up — confirmed locally by inspecting
  // .next/server/pages/api/**/*.nft.json after a build, which lists none of
  // pages/{404,500,_error,_app,_document}.js. The same gap exists for every
  // dynamic (SSR) page lambda, not just API routes, since neither the trace
  // includes them either. i18n (next-i18next.config.js) doesn't relocate these
  // pages — pages-manifest.json still maps them at /500, /404, /_error, not
  // locale-prefixed — so that's not the cause, just a red herring worth ruling
  // out.
  //
  // Fix: explicitly add the error-page bundles and their shared runtime chunks
  // to every route's trace. Globbing the whole chunks/ dir (not the numeric
  // chunk filenames 500.js currently happens to need) avoids hard-coding
  // webpack's content-hashed chunk ids, which can renumber on unrelated
  // changes; Vercel's Next.js builder dedupes identical files shared across
  // functions, so this doesn't multiply deploy size per-lambda.
  // https://nextjs.org/docs/pages/api-reference/config/next-config-js/output#caveats
  outputFileTracingIncludes: {
    '/**': [
      './.next/server/pages/_app.js',
      './.next/server/pages/_document.js',
      './.next/server/pages/404.js',
      './.next/server/pages/500.js',
      './.next/server/pages/_error.js',
      './.next/server/chunks/**/*.js',
      './.next/server/webpack-runtime.js',
    ],
  },

  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'boxyhq.com',
      },
      {
        protocol: 'https',
        hostname: 'files.stripe.com',
      },
    ],
  },
  i18n,
  rewrites: async () => {
    return [
      {
        source: '/.well-known/saml.cer',
        destination: '/api/well-known/saml.cer',
      },
      {
        source: '/.well-known/saml-configuration',
        destination: '/well-known/saml-configuration',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*?)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains;',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
        ],
      },
    ];
  },
};

// Additional config options for the Sentry webpack plugin.
// For all available options: https://github.com/getsentry/sentry-webpack-plugin#options.
const sentryWebpackPluginOptions = {
  silent: true,
  hideSourceMaps: true,
};

module.exports = withSentryConfig(nextConfig, sentryWebpackPluginOptions);
