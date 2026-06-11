// Load DATABASE_URL (and anything else) from a local .env file when present.
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the ambient environment.
}
