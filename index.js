const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://biblio-drop-a10.vercel.app" 
  ],
  credentials: true
}));
app.use(express.json()); 

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

// Database Setup
const uri = process.env.MONGODB_URI || process.env.MONGO_URI; 
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }   
});   

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/auth/jwks`));

// Database Globals
let subscriptionCollection, userCollection, booksCollection, paymentCollection;

async function dbConnect() {
  if (subscriptionCollection) return; // অলরেডি কানেক্টেড থাকলে আর করবে না
  try {
    await client.connect();
    const db = client.db("biblio-drop_db");
    subscriptionCollection = db.collection("subscription");
    userCollection = db.collection("user");
    booksCollection = db.collection("books");
    paymentCollection = db.collection("payment");
    console.log("MongoDB Connected!");
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
  }
}

// Middleware: Verification
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ msg: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  try {
    const { payload } = await jwtVerify(token, JWKS); 
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ msg: "Unauthorized" }); 
  }
};

const librarianVerify = async (req, res, next) => {
  if (req.user?.role !== "librarian") return res.status(403).json({ msg: "Forbidden" }); 
  next();
};

// Routes
app.get('/', (req, res) => res.json({ message: 'Server is running!' }));

app.post("/subscription", verifyToken, async (req, res) => {
  await dbConnect();
  try {
    const { sessionid, userId } = req.body;
    await subscriptionCollection.insertOne({ sessionId: sessionid, userId, createdAt: new Date() });
    await userCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: "user_pro" } });
    res.json({ msg: "Success" });
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.get("/books", async (req, res) => {
  await dbConnect();
  const result = await booksCollection.find().toArray();
  res.json(result);
});

// 

// Export for Vercel
module.exports = app;

// Local Development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port: ${PORT}`));
}