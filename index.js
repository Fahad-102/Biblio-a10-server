const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); 

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }  
});  

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

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

async function run() {
  try {
    await client.connect();
    const db = client.db("biblio-drop_db");
    const subscriptionCollection = db.collection("subscription");
    const userCollection = db.collection("user");
    const booksCollection = db.collection("books");
    const paymentCollection = db.collection("payment")

    // --- 1. Subscription Route ---
    app.post("/subscription", async (req, res) => {
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
        if (ObjectId.isValid(userId)) {
          query = { _id: new ObjectId(userId) };
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
    app.get("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid book ID format" });
        }

        const result = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).json({ error: "Book not found" });
        }
        res.send(result);
      } catch (error) {
        console.error("Error in /books/:id route:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

     app.patch("/books/:id", async (req, res) => {
        const { id } = req.params;
        const updatedData = req.body;

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          {$set: updatedData}
        );
        res.send(result);
    });

    // --- 3. Public Books Route (With Pagination & Search) ---
    app.get("/books", async (req, res) => {
      try {
        const { search, page = 1, limit = 8 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const query = {};

        if (search && search !== "undefined" && search.trim() !== "") {
          query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        const result = await booksCollection
          .find(query)
          .skip(skip)
          .limit(Number(limit))
          .toArray();

        const totalData = await booksCollection.countDocuments(query);
        const totalPage = Math.ceil(totalData / Number(limit));

        res.send({ 
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
    app.post("/librarian/books", verifyToken, librarianVerify, async (req, res) => {
      try {
        const data = req.body;
        // Fallback to standard jwt claim structures if req.user.id isn't directly populated
        const userId = req.user.id || req.user.sub; 
        
        const result = await booksCollection.insertOne({ ...data, userId });
        res.status(201).json(result);
      } catch (error) {
        console.error("Error adding book:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // --- 5. Librarian: Get Books (With Pagination) ---
    app.get("/librarian/books", verifyToken, librarianVerify, async (req, res) => {
      try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const userId = req.user.id || req.user.sub;

        const result = await booksCollection.find({ userId }).skip(skip).limit(Number(limit)).toArray();
        const totalData = await booksCollection.countDocuments({ userId });
        const totalPage = Math.ceil(totalData / Number(limit));
        
        res.send({ data: result, page: Number(page), totalPage, totalData });
      } catch (error) {
        console.error("Error fetching librarian books:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Confirm connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
  }
} 
run().catch(console.dir);

// Root Route
app.get('/', (req, res) => {
    res.send('Server is running smoothly!');
});

// Sample API Route
app.get('/api/data', (req, res) => {
    res.json({ message: "Hello from the separate backend server!" });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port: ${PORT}`);
});