/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  transpilePackages: ['three'],
  // The check-in page was renamed from /clock-in to /check-in so the URL matches
  // the wording shown in the app. The permanent redirect keeps any existing
  // links, bookmarks or QR posters pointing at the old path working.
  async redirects() {
    return [
      {
        source: '/clock-in',
        destination: '/check-in',
        permanent: true,
      },
      // The site root IS the entrance verification page, so a visitor who types
      // the bare domain lands where the QR poster points instead of on a
      // sign-in form they have no password for.
      //
      // Declared here rather than with redirect() in app/page.tsx on purpose: a
      // redirect from a page component is applied by the client router, so the
      // server still answers 200 and the browser paints the old shell first.
      // This is a real HTTP redirect - no flash, and it works without JS.
      //
      // Temporary (307), not permanent: this is a product choice that may
      // change, and a 308 cached in browsers is painful to undo.
      {
        source: '/',
        destination: '/verify',
        permanent: false,
      },
    ]
  },
  webpack: (config) => {
    config.externals.push({
      'utf-8-validate': 'commonjs utf-8-validate',
      'bufferutil': 'commonjs bufferutil',
    })
    return config
  },
};

module.exports = nextConfig;
