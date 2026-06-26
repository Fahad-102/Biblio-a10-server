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

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`))

const verifyToken = async (req,res,next)=>{
  const authHeader = req.headers.authorization;
  console.log(authHeader)
  if(!authHeader || !authHeader.startsWith("Bearer")){
    return res.status(401).json({msg:"Unauthorized"});
  }

  const token = authHeader.split(" ")[1]

  if(!token){
    return res.status(401).json({msg:"Unauthorized"});
  }

  try {
    const {payload} = await jwtVerify(token,JWKS) 
    req.user = payload
    next()
  } catch (error) {
    console.log(error)
    return res.status(401).json({msg:"Unauthorized"}); 
  }
}

const librarianVerify = async (req,res,next)=>{
  const user = req.user;
  if(user.role !== "librarian" ){
        return res.status(403).json({msg:"Forbidden"}); 

   }
  console.log("User from librarianVerify",user)
  next()
}

async function run() {
  try {
    await client.connect();
    const db = client.db("biblio-drop_db");
    const subscriptionCollection = db.collection("subscription");
    const userCollection = db.collection("user");
    const booksCollection = db.collection("books")



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
          { $set: { plan: "user_pro" } }
        );

        res.json({ msg: "Payment successful and user upgraded to user_pro" });

      } catch (routeError) {
        console.error("Error in /subscription route:", routeError);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });


    app.post("/librarian/books", verifyToken,librarianVerify ,async(req,res)=>{
      const data = req.body
      const result = await booksCollection.insertOne(data)

      res.json(result);
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