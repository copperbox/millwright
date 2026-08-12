/** Entry-point helpers shared by the runtime Lambda handlers. */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function log(message: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...fields }));
}
