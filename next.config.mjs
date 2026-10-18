/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse is loaded by path inside a worker thread (lib/pdfExtract.js),
  // so keep it out of the bundle and ship its files with the functions.
  serverExternalPackages: ["pdf-parse"],
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pdf-parse/**/*", "./node_modules/node-ensure/**/*"],
  },
};

export default nextConfig;
