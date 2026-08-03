const { MongoClient } = require("mongodb");

let authInstance = null;
let authPromise = null;

async function initAuth() {
  if (authInstance) return authInstance;
  if (authPromise) return authPromise;

  authPromise = (async () => {
    const { betterAuth } = await import("better-auth");
    const { mongodbAdapter } = await import("better-auth/adapters/mongodb");

    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const client = new MongoClient(uri);
    const db = client.db(process.env.AUTH_DB_NAME || "biblio-drop_db");

    authInstance = betterAuth({
      database: mongodbAdapter(db),
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL: process.env.BETTER_AUTH_URL,
      trustedOrigins: [
        "http://localhost:3000",
        process.env.CLIENT_URL || "https://biblio-drop-a10.vercel.app"
      ],
      emailAndPassword: { enabled: true },
      socialProviders: {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      },
    });

    return authInstance;
  })();

  return authPromise;
}

module.exports = { initAuth };