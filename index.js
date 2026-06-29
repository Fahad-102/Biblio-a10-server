const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

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
const uri = process.env.MONGODB_URI || process.env.MONGO_URI; 

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }  
});  

// JWKS
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/auth/jwks`));

// Middleware: Token Verification
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, JWKS); 
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);
    return res.status(401).json({ msg: "Unauthorized" }); 
  }
};

// Middleware: Librarian Verification
const librarianVerify = async (req, res, next) => {
  const user = req.user;
  if (!user || user.role !== "librarian") {
    return res.status(403).json({ msg: "Forbidden" }); 
  }
  next();
};

// --- MongoDB Global Collections Declaration ---
let subscriptionCollection, userCollection, booksCollection, paymentCollection;

async function dbConnect() {
  try {
    if (!client.topology || !client.topology.isConnected()) {
      await client.connect();
      console.log("Connected successfully to MongoDB!");
    }
    
    const db = client.db("biblio-drop_db");
    subscriptionCollection = db.collection("subscription");
    userCollection = db.collection("user");
    booksCollection = db.collection("books");
    paymentCollection = db.collection("payment");

  } catch (err) {
    console.error("MongoDB Connection Error:", err);
    throw err;
  }
}

// Helper middleware to ensure DB is connected before handling requests (Vercel Serverless Safety)
const ensureDbConnected = async (req, res, next) => {
  if (!subscriptionCollection || !userCollection || !booksCollection || !paymentCollection) {
    try {
      await dbConnect();
    } catch (err) {
      return res.status(500).json({ error: "Database connection failed", details: err.message });
    }
  }
  next();
};

app.get('/', (req, res) => {
    res.json({ message: 'Server is running smoothly!' });
});

// Sample API Route
app.get('/api/data', (req, res) => {
    res.json({ message: "Hello from the separate backend server!" });
});

// --- 1. Subscription Route (Secured with verifyToken) ---
app.post("/subscription", ensureDbConnected, verifyToken, async (req, res) => {
  try {
    const { sessionid, userId, planId, priceId } = req.body;

    if (!sessionid || !userId) {
      return res.status(400).json({ error: "Missing required fields: sessionid or userId" });
    }

    const isExist = await subscriptionCollection.findOne({ sessionId: sessionid });
    if (isExist) {
      return res.status(400).json({ msg: "Subscription already processed" });
    }

    await subscriptionCollection.insertOne({
      sessionId: sessionid,
      userId,
      planId: planId || "Standard Plan",
      priceId: priceId || null,
      createdAt: new Date()
    });

  
    let query = { _id: userId };
    try {
      if (ObjectId.isValid(userId) && String(new ObjectId(userId)) === userId) {
        query = { _id: new ObjectId(userId) };
      }
    } catch (e) {
      
      query = { _id: userId };
    }

    await userCollection.updateOne(
      query,
      { $set: { plan: "user_pro" } }
    );

    res.json({ msg: "Payment successful and user upgraded to user_pro" });

  } catch (routeError) {
    console.error("Error in /subscription route:", routeError);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- 2. Public Books Route (Single Book) ---
app.get("/books/:id", ensureDbConnected, async (req, res) => {
  try {
    const { id } = req.params;
    
   
    let query = { _id: id };
    if (ObjectId.isValid(id)) {
      query = { _id: new ObjectId(id) };
    }

    const result = await booksCollection.findOne(query);
    if (!result) {
      return res.status(404).json({ error: "Book not found" });
    }
    res.json(result);
  } catch (error) {
    console.error("Error in /books/:id route:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.patch("/books/:id", ensureDbConnected, verifyToken, librarianVerify, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;
    
    let query = { _id: id };
    if (ObjectId.isValid(id)) query = { _id: new ObjectId(id) };

    const result = await booksCollection.updateOne(
      query,
      { $set: updatedData }
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.delete("/books/:id", ensureDbConnected, verifyToken, librarianVerify, async (req, res) => {
  try {
    const { id } = req.params;
    
    let query = { _id: id };
    if (ObjectId.isValid(id)) query = { _id: new ObjectId(id) };

    const result = await booksCollection.deleteOne(query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- 3. Public Books Route (With Pagination & Search) ---
app.get("/books", ensureDbConnected, async (req, res) => {
  try {
    let { search, page = 1, limit = 8 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const query = {};

    if (search && search !== "undefined" && search.toString().trim() !== "") {
      query.$or = [
        { title: { $regex: search.toString().trim(), $options: 'i' } },
        { description: { $regex: search.toString().trim(), $options: 'i' } },
      ];
    }

    const result = await booksCollection
      .find(query)
      .skip(skip)
      .limit(Number(limit))
      .toArray();

    const totalData = await booksCollection.countDocuments(query);
    const totalPage = Math.ceil(totalData / Number(limit));

    res.json({ 
      data: result, 
      page: Number(page), 
      totalPage, 
      totalData 
    });
  } catch (error) {
    console.error("Error in /books public route:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- 4. Librarian: Add Book ---
app.post("/librarian/books", ensureDbConnected, verifyToken, librarianVerify, async (req, res) => {
  try {
    const data = req.body;
    const userId = req.user.id || req.user.sub; 
    
    const result = await booksCollection.insertOne({ ...data, userId });
    res.status(201).json(result);
  } catch (error) {
    console.error("Error adding book:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- 5. Librarian: Get Books (With Pagination) ---
app.get("/librarian/books", ensureDbConnected, verifyToken, librarianVerify, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const userId = req.user.id || req.user.sub;

    const result = await booksCollection.find({ userId }).skip(skip).limit(Number(limit)).toArray();
    const totalData = await booksCollection.countDocuments({ userId });
    const totalPage = Math.ceil(totalData / Number(limit));
    
    res.json({ data: result, page: Number(page), totalPage, totalData });
  } catch (error) {
    console.error("Error fetching librarian books:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Database boot and initialization
dbConnect()
  .then(() => {
    if (process.env.NODE_ENV !== 'production') {
        console.log("Database connection configured successfully.");
    }
    
    app.listen(PORT, () => {
        console.log(`Server running optimally on port: ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database boot error:", err);
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  });

module.exports = app;