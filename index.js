const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); 

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,  
    strict: true,
    deprecationErrors: true,
  }  
});  

async function run() {
  try {
    await client.connect();
    const db = client.db("biblio-drop_db");
    const subscriptionCollection = db.collection("subscription");
    const userCollection = db.collection("user");

    app.post("/subscription", async (req, res) => {
      try {
        const { sessionid, userId, planId, priceId } = req.body;

        if (!sessionid || !userId) {
          return res.status(400).json({ error: "Missing required fields: sessionid or userId" });
        }

        const isExist = await subscriptionCollection.findOne({ sessionId: sessionid });
        if (isExist) {
          return res.json({ msg: "Subscription already processed" });
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
          { $set: { role: "user_pro" } }
        );

        res.json({ msg: "Payment successful and user upgraded to user_pro" });

      } catch (routeError) {
        console.error("Error in /subscription route:", routeError);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Send a ping to confirm a successful connection
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